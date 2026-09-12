# Bandera y Sello

Country souvenir shop. Kit inventory lives in Postgres, country data (name,
capital, currency, flag) comes from REST Countries v5, and checkout builds the
Stripe `product_data` from both: the name is the kit template rendered with the
chosen country, the image is that country's flag URL.

Nothing about a country is stored or hardcoded. Kits store only templates.

## Run

```bash
docker compose up -d          # Postgres on :5433 (seeded from db/init.sql), Valkey on :6380
cp .env.example .env          # then fill in the two API keys
npm install
npm start                     # :3000
npm test
```

`.env` needs a REST Countries v5 key (`COUNTRIES_API_KEY`, free account at
restcountries.com) and a Stripe secret key (`STRIPE_SECRET_KEY`). The server
refuses to boot with either missing.

`npm test` is pure and hermetic (no env, no DB) by design, so `src/orders.ts`
and `src/webhooks.ts` — the webhook claim/dedupe logic — aren't in it.
`npm run test:integration` covers those: it spins up a throwaway `scratchtest`
database on the same Postgres container (never your dev data), runs the real
migration chain against it, and drives the actual webhook routes with signed
payloads. Needs `docker compose up -d` and a filled-in `.env`. There's no CI
in this repo, so it's a local-only safety net — run it by hand before
touching either file.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | 200, or 503 when Postgres is down |
| GET | `/api/countries` | Every country, sorted by name |
| GET | `/api/countries/:code` | alpha-2 or alpha-3 |
| GET | `/api/kits` | Kits with their raw templates |
| GET | `/api/kits?country=JPN` | Kits with the exact name/description/image checkout will send to Stripe |
| GET | `/api/souvenirs` | Every kit x every country, paginated (`limit` 1..200 default 48, `offset`). Backs the shop grid |
| GET | `/api/souvenirs?country=JPN` | Same, narrowed to one country. Backs the filter |
| GET | `/api/checkout/:sessionId` | Payment status and every purchased line. Backs the confirmation page |
| POST | `/api/checkout` | `{ items: [{ kitSku, countryCode, quantity? }] }`, 1..20 lines -> 201 with the Stripe Checkout URL |
| POST | `/api/webhooks/stripe` | Stripe webhook. On `checkout.session.completed`: records the order, then queues the confirmation email and the shipping label |
| POST | `/api/webhooks/shippo` | Shippo tracking webhook (`?token=` required). Emails a delivery-status update on each carrier status change |

### The API only answers its own page

`/api/*` is closed to everything except the shop's frontend: reads need
`Sec-Fetch-Site: same-origin`, and writes need an allow-listed `Origin` plus a
session-bound CSRF token (`X-CSRF-Token`, echoing the readable `csrf` cookie).
`curl https://.../api/kits` is a 403, and that is the point.

Be clear about what that buys. It stops another site driving this API with a
logged-in visitor's cookie — which was wide open, since `SameSite=Lax` was the
only control. It does **not** stop a scripted client: `Sec-Fetch-Site` is only
unforgeable by browser JavaScript. Automation is bounded by rate limits, not by
this. Nothing served to a browser can prove a request came from its own page.

Webhooks are exempt (Stripe and Clerk are not the frontend; they are gated by
signatures instead), as are the three HTML page routes and `/health`.

One cost worth knowing: Safari below 16.4 does not send `Sec-Fetch-Site` and so
cannot use the API at all.

## Queue (BullMQ) and the /admin surface

The Stripe webhook used to send the confirmation email and buy the shipping
label inline. Both had already failed in production — the email timed out
against a blocked SMTP port and took the handler down for 120s, the label threw
because a carrier had no rate to that country — and neither is something Stripe
can fix by retrying. Recording the payment is still synchronous, so an order can
never be lost to a queue; everything after it is a job with five attempts and
exponential backoff.

With no `REDIS_URL` the work runs inline exactly as before. A missing queue must
never cost a sale, and it keeps `npm test` free of Redis.

| Surface | Where | Auth |
|---|---|---|
| Dashboard | `/admin/queues/ui/` (trailing slash; without it you get a 301) | Basic — any username, `ADMIN_TOKEN` as the password |
| JSON API | `/admin/queues/*` | `Authorization: Bearer $ADMIN_TOKEN` |

`/admin` is deliberately **not** under `/api`, because that prefix is closed to
everything but the browser and this is a surface you drive from Postman. One rule
per surface, neither weakening the other. `postman/bandera-queues.postman_collection.json`
drives all of it — set `baseUrl` and `adminToken`, or run it headless:

```bash
npx newman run postman/bandera-queues.postman_collection.json \
  --env-var baseUrl=http://localhost:3000 --env-var adminToken=$ADMIN_TOKEN
```

Every operation the app performs is its own endpoint. There is no generic
"enqueue this blob" route: that accepted any shape and only failed later, inside
the worker, where the caller never saw it — so a typo looked like a successful
enqueue. Each body is validated, and the queue a job lands on is a property of
the operation rather than something the caller picks. All four answer `202` with
a job id and a `status` URL to follow it.

| Method | Path | Body |
| ------ | ---- | ---- |
| POST | `/admin/jobs/payment-confirmation` | `{ sessionId, delayMs? }` |
| POST | `/admin/jobs/welcome` | `{ to, delayMs? }` |
| POST | `/admin/jobs/shipping-status` | `{ sessionId, to, status, trackingNumber?, delayMs? }` — `status` is one of `in_transit`, `delivered`, `failed`, `returned` |
| POST | `/admin/jobs/purchase-label` | `{ sessionId, delayMs? }` |
| GET | `/admin/jobs/:queue/:id` | Follow one job: state, attempts, failure reason |

And the queue-level view:

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/admin/queues/health` | Answers even with no Redis, so it tells you whether the queue is configured at all |
| GET | `/admin/queues/stats` | Job counts and paused state per queue |
| GET | `/admin/queues/:name/jobs?state=&limit=` | `active`\|`waiting`\|`delayed`\|`completed`\|`failed` |
| POST | `/admin/queues/:name/jobs/:id/retry` | 409 with the actual state if the job is not finished |
| DELETE | `/admin/queues/:name/jobs/:id` | 409 if the worker currently holds a lock on it |

The Key Value instance **must** run `maxmemory-policy=noeviction`. Any `allkeys-*`
policy silently evicts live job data, which looks exactly like jobs vanishing for
no reason.

## Status codes

- `400` request failed schema validation (bad code format, unknown body field, empty cart, over 20 lines, quantity outside 1..10)
- `404` no such country, kit, checkout session, or route
- `409` a kit is inactive or has less stock than the cart asks for, counting every line that shares it
- `422` the country lacks data a kit template needs (no capital, no currency), the cart mixes currencies, or Stripe rejected a line item
- `502` REST Countries or Stripe failed
- `503` database unreachable

## Cart

The shop page keeps the cart in `localStorage` and posts the whole thing to
`POST /api/checkout` as one order. Stock lives on the kit, not the kit-country
pair, so quantities are summed per sku before anything is held, and the holds
run in one transaction in sku order: two concurrent carts touch the rows in the
same order and cannot deadlock, and a cart that cannot be filled leaves no stock
held. A Stripe session carries a single currency, so a cart spanning two of them
is refused with `422 mixed_currency` rather than sold at the wrong price.

Each Stripe line item carries its own `kit_sku` and `country_code` metadata,
which is how the confirmation page names the countries in a multi-line order.

## Sanitizing

Fastify JSON schemas reject unknown body fields and malformed codes before any
handler runs. SQL goes through parameterized queries only. Text bound for Stripe
is stripped of control characters, whitespace-collapsed and truncated to Stripe's
limits, and the flag URL must be a plain `https:` URL with no credentials before
it is passed as a product image.

## Order emails (payment confirmation + delivery status)

Checkout now collects a real shipping address, and paying triggers two kinds
of email through Brevo's SMTP relay:

1. **Payment confirmed** — sent from `POST /api/webhooks/stripe` on
   `checkout.session.completed`. The same handler then buys a Shippo shipping
   label for the collected address.
2. **Delivery status** (shipped / delivered / delivery problem / returned) —
   sent from `POST /api/webhooks/shippo` whenever Shippo's `track_updated`
   webhook reports a new carrier status for that label.

Orders (email, payment/shipping status, tracking number) live in a new
`orders` table; `processed_webhook_events` makes both webhooks idempotent
against Stripe/Shippo's own retries: an event id is claimed atomically before
the handler runs and released again if it throws, so a failed send stays
retryable instead of being swallowed as a duplicate.

Migrations in `db/` no longer need running by hand. `docker compose`'s
`initdb.d` only fires on a fresh volume, so `src/migrate.ts` applies them on
boot instead — that is also what provisions a hosted database on first deploy.

Setup, one time, outside this repo:

- **Stripe**: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`
  locally (copy the printed signing secret into `STRIPE_WEBHOOK_SECRET`), or
  add the endpoint for `checkout.session.completed` in the Stripe Dashboard
  for a deployed URL.
- **Brevo**: create an SMTP key in the Brevo dashboard and set
  `BREVO_SMTP_USER`/`BREVO_SMTP_PASS`/`EMAIL_FROM` (the sender must be
  verified in Brevo).
- **Shippo**: register `https://<your-host>/api/webhooks/shippo?token=<SHIPPO_WEBHOOK_TOKEN>`
  as a webhook for the `track_updated` event (Shippo dashboard or
  `shippo.webhooks.create()`) — Shippo does not sign its payloads, so this
  token is the access control for that endpoint.

Any of these can be left unset: the affected webhook route then answers
`503 webhook_unconfigured` (Stripe/Shippo secrets) or the email is skipped
and logged (Brevo creds), same as `SHIPPO_API_KEY` being optional today.

## Known shortcuts

Grep for `ponytail:` comments — eight today. The one that actually costs money:
checkout holds stock the moment the Stripe session is created and nothing
releases it, so every abandoned cart leaks up to 20 lines of stock until someone
puts them back by hand. There is no `checkout.session.expired` webhook yet.

The rest are bounded: the country catalog and the chat rate limiter are both
in-process (fine while this is one instance, wrong the moment it is two), the
queue worker shares the web process because Render has no background-worker
service on the free tier — and a free web service hibernates, so nothing drains
the queue while the app is asleep and free Key Value loses everything queued on
restart,
`src/parcel.ts` stacks a box without bin packing and reads a static zone table
rather than the carrier's coverage API, `src/match.ts` does prefix and substring
matching only so a typo finds nothing, and `src/clerkWebhook.ts` deliberately
marks an event handled only after the welcome email sends — a duplicate hello
under a concurrent retry, traded against never retrying a failed send.

## Notes from wiring it up

REST Countries v3.1 was deprecated; this targets v5, which needs a bearer key and
paginates. Free-plan keys cap `limit` at 100 per request, which is why
`PAGE_SIZE` is 100 (paid plans allow 500). The catalogue is 254 records, of which
250 survive normalising: a few partially-recognised territories ship an empty
`alpha_3` and no flag URL, and a kit with no flag is not a kit.
