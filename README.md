# Bandera y Sello

Country souvenir shop. Kit inventory lives in Postgres, country data (name,
capital, currency, flag) comes from REST Countries v5, and checkout builds the
Stripe `product_data` from both: the name is the kit template rendered with the
chosen country, the image is that country's flag URL.

Nothing about a country is stored or hardcoded. Kits store only templates.

## Run

```bash
docker compose up -d          # Postgres on :5433, seeded from db/init.sql
cp .env.example .env          # then fill in the two API keys
npm install
npm start                     # :3000
npm test
```

`.env` needs a REST Countries v5 key (`COUNTRIES_API_KEY`, free account at
restcountries.com) and a Stripe secret key (`STRIPE_SECRET_KEY`). The server
refuses to boot with either missing.

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

## Known shortcuts

Grep for `ponytail:` comments. Two today: the country catalog is cached in
process (fine for one instance), and checkout holds stock immediately without a
`checkout.session.expired` webhook to release abandoned carts. The second one
bites harder now that one abandoned checkout can hold up to 20 lines of stock.
The chat panel on the shop page is front-end only: its `answer()` stub returns a
canned reply until the assistant and its catalogue MCP are wired up.

## Notes from wiring it up

REST Countries v3.1 was deprecated; this targets v5, which needs a bearer key and
paginates. Free-plan keys cap `limit` at 100 per request, which is why
`PAGE_SIZE` is 100 (paid plans allow 500). The catalogue is 254 records, of which
250 survive normalising: a few partially-recognised territories ship an empty
`alpha_3` and no flag URL, and a kit with no flag is not a kit.
