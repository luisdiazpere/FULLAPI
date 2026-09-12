import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError, type FastifyRequest } from 'fastify';
import Stripe from 'stripe';
import { env } from './env.ts';
import { pool, type Kit } from './db.ts';
import { holdPlan, type CartLine } from './cart.ts';
import { NOT_SERVED, ZONES, parcelFor, zoneFor, type Parcel, type ShipLine } from './parcel.ts';
import {
  ShippingUnconfiguredError,
  ShippingUpstreamError,
  quote,
  shippingConfigured,
} from './shipping.ts';
import { UpstreamError, findCountry, listCountries, type Country } from './countries.ts';
import { clean, httpsImage, render } from './format.ts';
import { stripe, loadSession } from './stripeClient.ts';
import webhooks from './webhooks.ts';
import clerkWebhook from './clerkWebhook.ts';
import { runMigrations } from './migrate.ts';
import { allowChat, chatConfigured, chatReply, ChatUnconfiguredError, ChatUpstreamError } from './chat.ts';
import {
  allowAuthAttempt,
  clearCsrfCookie,
  clearSessionCookie,
  csrfCookie,
  parseSessionCookie,
  sessionCookie,
} from './auth.ts';
import perimeter, { csrfFor, internalHeaders } from './perimeter.ts';
import { ShopError, type ShopCall } from './mcp/call.ts';
import adminRoutes from './adminRoutes.ts';
import { closeQueues, queueConfigured, startWorkers } from './queue.ts';
import { handlers } from './jobs.ts';
import { createSession, destroySession, getSession, type Session } from './sessions.ts';
import {
  ClerkAuthError,
  ClerkUnconfiguredError,
  clerkConfigured,
  clerkEmailFromSessionToken,
  clerkSignUp,
  clerkVerify,
} from './clerkAuth.ts';

export const app = Fastify({
  logger: true,
  bodyLimit: 16 * 1024,
  // Trust exactly one hop: Render's edge, which is always the immediate peer.
  // Without this, req.ip is the edge's address and every visitor shares one rate-limit
  // bucket, and req.protocol never says https so the session cookie loses Secure.
  //
  // Not `true`: that walks the whole X-Forwarded-For chain, and the client writes the
  // left of it, so req.ip becomes attacker-chosen. Not the number 1 either — Fastify
  // reads a numeric trustProxy as "trust nothing" and fails closed (lib/request.js:51),
  // so it would look like this line works while changing nothing.
  trustProxy: (_address, hop) => hop === 0,
  // Fastify's ajv defaults to removeAdditional:true, which silently drops unknown
  // body fields. At a trust boundary we'd rather say no than quietly accept.
  ajv: { customOptions: { removeAdditional: false } },
});
await app.register(webhooks);
await app.register(clerkWebhook);

// Called, not registered: register() would encapsulate the hook into a child context
// with no routes in it. Called here it lands on the root and covers every route defined
// below. Order matters — the two webhook plugins above already have their own context,
// so they stay exempt, which is what we want: Stripe and Clerk are not the frontend.
await perimeter(app);

// /admin is not under /api, so the perimeter above ignores it by design: it is gated
// by ADMIN_TOKEN instead, which is what lets Postman drive it.
await app.register(adminRoutes);

const MAX_LINES = 20;
const NAME_MAX = 250;
const DESCRIPTION_MAX = 500;

const fail = (code: string, message: string, details?: unknown) => ({
  error: { code, message, details },
});

const countryCodeSchema = { type: 'string', pattern: '^[A-Za-z]{2,3}$' } as const;
const sessionIdSchema = { type: 'string', pattern: '^cs_[A-Za-z0-9_]{10,200}$' } as const;
const kitSkuSchema = { type: 'string', pattern: '^[a-z0-9-]{1,64}$' } as const;
const emailSchema = { type: 'string', format: 'email', maxLength: 200 } as const;
const passwordSchema = { type: 'string', minLength: 8, maxLength: 200 } as const;

/**
 * How the chat's tools reach the shop, now that /api/* is closed to everything but the
 * page. app.inject() is a function call, not a socket — nothing off the network can
 * reach it — so stamping the same-origin markers here is not a hole an attacker can
 * use, it is how an in-process caller identifies itself. It carries the shopper's own
 * cookie, so every route still authorizes them exactly as it would over the wire.
 */
const internalCall =
  (cookie?: string): ShopCall =>
  async <T,>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: path,
      headers: {
        ...internalHeaders(cookie),
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(init?.body ? { payload: init.body as object } : {}),
    });

    const body = res.json<(T & { error?: { code?: string; message?: string; details?: unknown } }) | null>();
    if (res.statusCode >= 400) {
      throw new ShopError(
        res.statusCode,
        body?.error?.code ?? 'http_error',
        body?.error?.message ?? `the shop returned ${res.statusCode}`,
        body?.error?.details,
      );
    }
    return body as T;
  };

/** Reads and validates the session cookie; null if there is none or it is stale. */
async function currentSession(req: { headers: { cookie?: string } }): Promise<Session | null> {
  const token = parseSessionCookie(req.headers.cookie);
  return token ? getSession(token) : null;
}

/** Renders one kit against one country, and says why it can't be sold if it can't. */
function kitFor(kit: Kit, country: Country) {
  const vars = {
    country: country.name,
    capital: country.capital,
    currency: country.currency?.code,
    code: country.code,
  };
  const name = render(kit.name_template, vars);
  const description = render(kit.description_template, vars);
  const image = httpsImage(country.flag.url);
  const missing = [...new Set([...name.missing, ...description.missing])];

  let blocked: string | null = null;
  if (missing.length) blocked = `no ${missing.join('/')} data for ${country.name}`;
  else if (!image) blocked = `unusable flag image for ${country.name}`;

  return {
    name: clean(name.text, NAME_MAX),
    description: clean(description.text, DESCRIPTION_MAX),
    image,
    blocked,
  };
}

/** REST Countries being down is a 502 from us, not a 500. */
function upstream(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  if (!(err instanceof UpstreamError)) throw err;
  return reply.code(502).send(fail('countries_upstream', err.message));
}

app.get('/health', async (_req, reply) => {
  try {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  } catch {
    return reply.code(503).send(fail('db_unavailable', 'database is not reachable'));
  }
});

app.get('/api/countries', async (_req, reply) => {
  try {
    return await listCountries();
  } catch (err) {
    return upstream(err, reply);
  }
});

app.get<{ Params: { code: string } }>(
  '/api/countries/:code',
  { schema: { params: { type: 'object', required: ['code'], properties: { code: countryCodeSchema } } } },
  async (req, reply) => {
    try {
      const country = await findCountry(req.params.code);
      if (!country) return reply.code(404).send(fail('country_not_found', 'no country with that code'));
      return country;
    } catch (err) {
      return upstream(err, reply);
    }
  },
);

app.get<{ Querystring: { country?: string } }>(
  '/api/kits',
  {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { country: countryCodeSchema },
      },
    },
  },
  async (req, reply) => {
    const { rows } = await pool.query<Kit>('SELECT * FROM kits WHERE active ORDER BY unit_amount');

    if (!req.query.country) {
      return rows.map((k) => ({
        sku: k.sku,
        unitAmount: k.unit_amount,
        currency: k.currency,
        stock: k.stock,
        nameTemplate: k.name_template,
        descriptionTemplate: k.description_template,
      }));
    }

    let found: Country | null;
    try {
      found = await findCountry(req.query.country);
    } catch (err) {
      return upstream(err, reply);
    }
    if (!found) return reply.code(404).send(fail('country_not_found', 'no country with that code'));

    const country = found;
    return rows.map((k) => {
      const preview = kitFor(k, country);
      return {
        sku: k.sku,
        unitAmount: k.unit_amount,
        currency: k.currency,
        stock: k.stock,
        // Exactly what POST /api/checkout will send to Stripe.
        name: preview.name,
        description: preview.description,
        image: preview.image,
        purchasable: !preview.blocked && k.stock > 0,
        unavailableReason: preview.blocked ?? (k.stock > 0 ? null : 'out of stock'),
      };
    });
  },
);

/**
 * Every active kit against every country, paginated. Each row is rendered with
 * the same kitFor() checkout uses, so what the shop shows is what Stripe receives.
 */
app.get<{ Querystring: { country?: string; limit?: number; offset?: number } }>(
  '/api/souvenirs',
  {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          country: countryCodeSchema,
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 48 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  },
  async (req, reply) => {
    const { limit = 48, offset = 0 } = req.query;
    const { rows } = await pool.query<Kit>('SELECT * FROM kits WHERE active ORDER BY unit_amount');

    let countries: Country[];
    try {
      if (req.query.country) {
        const found = await findCountry(req.query.country);
        if (!found) {
          return reply.code(404).send(fail('country_not_found', 'no country with that code'));
        }
        countries = [found];
      } else {
        countries = await listCountries();
      }
    } catch (err) {
      return upstream(err, reply);
    }

    const total = countries.length * rows.length;
    const items = [];
    for (let i = offset; i < Math.min(offset + limit, total); i += 1) {
      const country = countries[Math.floor(i / rows.length)]!;
      const kit = rows[i % rows.length]!;
      const product = kitFor(kit, country);
      items.push({
        id: `${kit.sku}:${country.code}`,
        sku: kit.sku,
        country: { code: country.code, name: country.name, emoji: country.flag.emoji },
        name: product.name,
        description: product.description,
        image: product.image,
        unitAmount: kit.unit_amount,
        currency: kit.currency,
        purchasable: !product.blocked && kit.stock > 0,
        unavailableReason: product.blocked ?? (kit.stock > 0 ? null : 'out of stock'),
      });
    }

    return { total, limit, offset, items };
  },
);

/** `sku:qty` pairs, up to the same 20 lines a cart can carry. */
const shipItemsSchema = {
  type: 'string',
  pattern: '^[a-z0-9-]{1,64}:([1-9]|10)(,[a-z0-9-]{1,64}:([1-9]|10)){0,19}$',
} as const;

app.get('/api/shipping/destinations', async () => ({
  zones: ZONES.map((z) => ({
    zone: z.zone,
    methods: z.methods,
    countries: z.countries === '*' ? 'everywhere else' : z.countries,
  })),
  notServed: NOT_SERVED,
}));

app.get<{ Querystring: { country: string; items: string } }>(
  '/api/shipping/quote',
  {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        required: ['country', 'items'],
        properties: { country: countryCodeSchema, items: shipItemsSchema },
      },
    },
  },
  async (req, reply) => {
    const lines: ShipLine[] = req.query.items.split(',').map((pair) => {
      const [kitSku, quantity] = pair.split(':');
      return { kitSku: kitSku!, quantity: Number(quantity) };
    });

    let country: Country | null;
    try {
      country = await findCountry(req.query.country);
    } catch (err) {
      return upstream(err, reply);
    }
    if (!country) return reply.code(404).send(fail('country_not_found', 'no country with that code'));

    const skus = [...new Set(lines.map((l) => l.kitSku))];
    const { rows } = await pool.query<Kit>(
      'SELECT * FROM kits WHERE active AND sku = ANY($1)',
      [skus],
    );
    const dims = new Map<string, Parcel>(
      rows.map((k) => [
        k.sku,
        { weightGrams: k.weight_grams, lengthCm: k.length_cm, widthCm: k.width_cm, heightCm: k.height_cm },
      ]),
    );
    const unknown = skus.find((sku) => !dims.has(sku));
    if (unknown) {
      return reply.code(404).send(fail('kit_not_found', `no kit with sku ${unknown}`, { kitSku: unknown }));
    }

    // "We don't ship there" is a true answer to a well-formed question, so it is a
    // 200 with a reason. A 4xx would push the caller into retrying something no
    // retry can fix.
    const zone = zoneFor(country.code);
    if (!zone) {
      return { country: { code: country.code, name: country.name }, serviceable: false,
        reason: `we do not ship to ${country.name}` };
    }

    // Checked after validation, so a misconfigured deployment still calls bad input bad.
    if (!shippingConfigured()) {
      return reply.code(503).send(fail('shipping_unconfigured', 'shipping quotes are not configured'));
    }

    const parcel = parcelFor(lines, dims);
    let rates;
    try {
      rates = await quote(parcel, country.alpha2 || country.code);
    } catch (err) {
      if (err instanceof ShippingUnconfiguredError) {
        return reply.code(503).send(fail('shipping_unconfigured', err.message));
      }
      if (err instanceof ShippingUpstreamError) {
        return reply.code(502).send(fail('shipping_upstream', err.message));
      }
      throw err;
    }

    if (!rates.length) {
      return { country: { code: country.code, name: country.name }, zone: zone.zone, parcel,
        serviceable: false,
        reason: `no carrier service to ${country.name} for a ${parcel.weightGrams}g parcel` };
    }

    return {
      country: { code: country.code, name: country.name },
      zone: zone.zone,
      parcel,
      serviceable: true,
      methods: rates,
    };
  },
);

// Stripe requires an explicit ISO-3166-1 alpha-2 allow-list for shipping address
// collection (no wildcard) — this is every country Stripe itself supports for it.
const STRIPE_SHIPPABLE_COUNTRIES: Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[] = [
  'AC', 'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO',
  'CR', 'CV', 'CW', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER',
  'ES', 'ET', 'FI', 'FJ', 'FK', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL',
  'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HN', 'HR', 'HT', 'HU', 'ID',
  'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI',
  'KM', 'KN', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV',
  'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MK', 'ML', 'MM', 'MN', 'MO', 'MQ', 'MR', 'MS', 'MT',
  'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU',
  'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PY', 'QA',
  'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL',
  'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SZ', 'TA', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ',
  'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'US', 'UY', 'UZ', 'VA',
  'VC', 'VE', 'VG', 'VN', 'VU', 'WF', 'WS', 'XK', 'YE', 'YT', 'ZA', 'ZM', 'ZW', 'ZZ',
];

type CheckoutBody = { items: CartLine[] };

app.post<{ Body: CheckoutBody }>(
  '/api/checkout',
  {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_LINES,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kitSku', 'countryCode'],
              properties: {
                kitSku: kitSkuSchema,
                countryCode: countryCodeSchema,
                quantity: { type: 'integer', minimum: 1, maximum: 10, default: 1 },
              },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const session = await currentSession(req);
    if (!session) return reply.code(401).send(fail('auth_required', 'log in to check out'));

    const { items } = req.body;

    // Countries are resolved before any stock moves: an upstream outage should
    // not leave a hold behind.
    const countries = new Map<string, Country>();
    try {
      for (const code of new Set(items.map((item) => item.countryCode))) {
        const country = await findCountry(code);
        if (!country) {
          return reply.code(404).send(fail('country_not_found', `no country with code ${code}`));
        }
        countries.set(code, country);
      }
    } catch (err) {
      return upstream(err, reply);
    }

    // ponytail: stock is held when the session is created and never released if the
    // buyer walks away. Add a checkout.session.expired webhook when that leak matters.
    const plan = holdPlan(items);
    const kits = new Map<string, Kit>();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [sku, quantity] of plan) {
        const held = await client.query<Kit>(
          'UPDATE kits SET stock = stock - $2 WHERE sku = $1 AND active AND stock >= $2 RETURNING *',
          [sku, quantity],
        );
        if (!held.rowCount) {
          await client.query('ROLLBACK');
          const { rows } = await client.query<Kit>('SELECT * FROM kits WHERE sku = $1', [sku]);
          if (!rows[0]) return reply.code(404).send(fail('kit_not_found', `no kit with sku ${sku}`));
          return reply.code(409).send(
            fail('kit_unavailable', rows[0].active ? 'not enough stock' : 'kit is not for sale', {
              kitSku: sku,
              stock: rows[0].stock,
              requested: quantity,
            }),
          );
        }
        kits.set(sku, held.rows[0]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const release = () =>
      Promise.all(
        plan.map(([sku, quantity]) =>
          pool.query('UPDATE kits SET stock = stock + $2 WHERE sku = $1', [sku, quantity]),
        ),
      ).catch((err) => req.log.error({ err, plan }, 'failed to release held stock'));

    // A Stripe session carries one currency, so a mixed cart cannot be sold as one order.
    const currencies = new Set([...kits.values()].map((kit) => kit.currency));
    if (currencies.size > 1) {
      await release();
      return reply
        .code(422)
        .send(fail('mixed_currency', 'one order cannot mix currencies', { currencies: [...currencies] }));
    }

    const lines = [];
    for (const item of items) {
      const kit = kits.get(item.kitSku)!;
      const country = countries.get(item.countryCode)!;
      const product = kitFor(kit, country);
      if (product.blocked) {
        await release();
        return reply.code(422).send(fail('kit_not_renderable', product.blocked));
      }
      lines.push({ kit, country, product, quantity: item.quantity ?? 1 });
    }

    try {
      const checkoutSession = await stripe.checkout.sessions.create({
        mode: 'payment',
        success_url: env.CHECKOUT_SUCCESS_URL,
        cancel_url: env.CHECKOUT_CANCEL_URL,
        customer_email: session.email,
        shipping_address_collection: { allowed_countries: STRIPE_SHIPPABLE_COUNTRIES },
        line_items: lines.map(({ kit, country, product, quantity }) => ({
          quantity,
          price_data: {
            currency: kit.currency,
            unit_amount: kit.unit_amount,
            product_data: {
              name: product.name,
              description: product.description,
              images: [product.image as string],
              // Per line, because one session no longer maps to one kit.
              metadata: { kit_sku: kit.sku, country_code: country.code },
            },
          },
        })),
      });

      return reply.code(201).send({
        sessionId: checkoutSession.id,
        url: checkoutSession.url,
        amountTotal: checkoutSession.amount_total,
        currency: checkoutSession.currency,
        items: lines.map(({ kit, country, product, quantity }) => ({
          kitSku: kit.sku,
          countryCode: country.code,
          quantity,
          name: product.name,
          description: product.description,
          image: product.image,
        })),
      });
    } catch (err) {
      await release();
      req.log.error({ err }, 'stripe checkout session failed');
      const badInput =
        err instanceof Stripe.errors.StripeError && err.type === 'StripeInvalidRequestError';
      return reply
        .code(badInput ? 422 : 502)
        .send(fail('stripe_failed', 'could not create the checkout session'));
    }
  },
);

/**
 * Backs the post-payment confirmation.
 *
 * The id used to be the only key, on the grounds that it is unguessable. It isn't a
 * secret though: it rides in the /success?session_id= URL, so it lands in history,
 * referrers and screenshots, and it is inside every confirmation email. Anyone holding
 * one read the buyer's email address off this route — and because /api/chat is open to
 * anonymous visitors, they could get the shop's own assistant to read it for them.
 *
 * A non-owner gets the same 404 as a nonexistent session, so this never confirms that
 * an id is real.
 */
app.get<{ Params: { sessionId: string } }>(
  '/api/checkout/:sessionId',
  {
    schema: {
      params: { type: 'object', required: ['sessionId'], properties: { sessionId: sessionIdSchema } },
    },
  },
  async (req, reply) => {
    const me = await currentSession(req);
    if (!me) return reply.code(401).send(fail('auth_required', 'log in to view this order'));
    try {
      const session = await loadSession(req.params.sessionId);
      // customer_email is what we set from the logged-in account at creation, so it is
      // present even before payment completes; customer_details fills in later.
      const owner = session.session.customer_email ?? session.email;
      if (owner?.toLowerCase() !== me.email.toLowerCase()) {
        return reply.code(404).send(fail('session_not_found', 'no checkout session with that id'));
      }
      return {
        status: session.status,
        paymentStatus: session.paymentStatus,
        amountTotal: session.amountTotal,
        currency: session.currency,
        email: session.email,
        items: session.items,
      };
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError && err.code === 'resource_missing') {
        return reply.code(404).send(fail('session_not_found', 'no checkout session with that id'));
      }
      req.log.error({ err }, 'stripe session lookup failed');
      return reply.code(502).send(fail('stripe_failed', 'could not read the checkout session'));
    }
  },
);

/**
 * Render terminates TLS at its edge and forwards plain HTTP. With trustProxy set,
 * Fastify derives req.protocol from the forwarded header itself — reading that header
 * by hand here would take it from any client, secure or not.
 */
const isSecureRequest = (req: FastifyRequest): boolean => req.protocol === 'https';

type AuthBody = { email: string; password: string };

const authBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'password'],
  properties: { email: emailSchema, password: passwordSchema },
} as const;

app.post<{ Body: AuthBody }>(
  '/api/auth/signup',
  { schema: { body: authBodySchema } },
  async (req, reply) => {
    if (!clerkConfigured()) return reply.code(503).send(fail('auth_unconfigured', 'CLERK_SECRET_KEY is not set'));
    if (!allowAuthAttempt(req.ip)) {
      return reply.code(429).send(fail('rate_limited', 'too many attempts, slow down'));
    }
    const email = req.body.email.trim().toLowerCase();
    try {
      await clerkSignUp(email, req.body.password);
    } catch (err) {
      if (err instanceof ClerkUnconfiguredError) {
        req.log.error({ err }, 'Clerk rejected our secret key');
        return reply.code(503).send(fail('auth_unconfigured', 'auth is misconfigured on this deployment'));
      }
      if (err instanceof ClerkAuthError) {
        const status = err.code === 'email_taken' ? 409 : 422;
        return reply.code(status).send(fail(err.code, err.message));
      }
      throw err;
    }

    const { token, expiresAt } = await createSession(email);
    reply.header('set-cookie', [
      sessionCookie(token, expiresAt, isSecureRequest(req)),
      csrfCookie(csrfFor(token), expiresAt, isSecureRequest(req)),
    ]);
    return reply.code(201).send({ email });
  },
);

app.post<{ Body: AuthBody }>(
  '/api/auth/login',
  { schema: { body: authBodySchema } },
  async (req, reply) => {
    if (!clerkConfigured()) return reply.code(503).send(fail('auth_unconfigured', 'CLERK_SECRET_KEY is not set'));
    if (!allowAuthAttempt(req.ip)) {
      return reply.code(429).send(fail('rate_limited', 'too many attempts, slow down'));
    }
    const email = req.body.email.trim().toLowerCase();
    let verified: boolean;
    try {
      verified = await clerkVerify(email, req.body.password);
    } catch (err) {
      if (err instanceof ClerkUnconfiguredError) {
        req.log.error({ err }, 'Clerk rejected our secret key');
        return reply.code(503).send(fail('auth_unconfigured', 'auth is misconfigured on this deployment'));
      }
      throw err;
    }
    if (!verified) {
      // Same message either way: it should not be possible to tell a wrong password
      // from an email that was never registered.
      return reply.code(401).send(fail('invalid_credentials', 'invalid email or password'));
    }
    const { token, expiresAt } = await createSession(email);
    reply.header('set-cookie', [
      sessionCookie(token, expiresAt, isSecureRequest(req)),
      csrfCookie(csrfFor(token), expiresAt, isSecureRequest(req)),
    ]);
    return { email };
  },
);

type GoogleCallbackBody = { sessionToken: string };

const googleCallbackBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionToken'],
  properties: { sessionToken: { type: 'string', minLength: 10, maxLength: 4000 } },
} as const;

/** The browser lands here right after Clerk finishes the Google redirect; it hands us the
 * Clerk session token it just got, which we verify ourselves before minting our own cookie. */
app.post<{ Body: GoogleCallbackBody }>(
  '/api/auth/google-callback',
  { schema: { body: googleCallbackBodySchema } },
  async (req, reply) => {
    if (!clerkConfigured()) return reply.code(503).send(fail('auth_unconfigured', 'CLERK_SECRET_KEY is not set'));
    if (!allowAuthAttempt(req.ip)) {
      return reply.code(429).send(fail('rate_limited', 'too many attempts, slow down'));
    }
    let email: string;
    try {
      email = await clerkEmailFromSessionToken(req.body.sessionToken);
    } catch (err) {
      if (err instanceof ClerkUnconfiguredError) {
        req.log.error({ err }, 'Clerk rejected our secret key');
        return reply.code(503).send(fail('auth_unconfigured', 'auth is misconfigured on this deployment'));
      }
      if (err instanceof ClerkAuthError) {
        return reply.code(401).send(fail(err.code, err.message));
      }
      throw err;
    }
    const { token, expiresAt } = await createSession(email);
    reply.header('set-cookie', [
      sessionCookie(token, expiresAt, isSecureRequest(req)),
      csrfCookie(csrfFor(token), expiresAt, isSecureRequest(req)),
    ]);
    return reply.code(200).send({ email });
  },
);

app.post('/api/auth/logout', async (req, reply) => {
  const token = parseSessionCookie(req.headers.cookie);
  if (token) await destroySession(token);
  reply.header('set-cookie', [
    clearSessionCookie(isSecureRequest(req)),
    clearCsrfCookie(isSecureRequest(req)),
  ]);
  return { ok: true };
});

app.get('/api/auth/me', async (req, reply) => {
  const session = await currentSession(req);
  if (!session) return reply.code(401).send(fail('not_logged_in', 'not logged in'));

  // Re-issue the CSRF cookie for anyone whose session predates it. Sessions last 30
  // days, so without this every already-logged-in shopper would hit a 403 on their
  // next checkout and have to work out that logging out fixes it. The page calls this
  // on boot, so the repair happens before they can click anything.
  const token = parseSessionCookie(req.headers.cookie);
  if (token) {
    reply.header(
      'set-cookie',
      csrfCookie(csrfFor(token), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), isSecureRequest(req)),
    );
  }
  return session;
});

type OrderRow = {
  session_id: string;
  amount_total: number | null;
  currency: string | null;
  payment_status: string;
  shipping_status: string;
  tracking_number: string | null;
  tracking_url: string | null;
  created_at: Date;
};

/** Order history for the logged-in account — the receipt trail, not a public lookup. */
app.get('/api/orders', async (req, reply) => {
  const session = await currentSession(req);
  if (!session) return reply.code(401).send(fail('auth_required', 'log in to see your orders'));
  const { rows } = await pool.query<OrderRow>(
    `SELECT session_id, amount_total, currency, payment_status, shipping_status,
            tracking_number, tracking_url, created_at
     FROM orders WHERE email = $1 ORDER BY created_at DESC LIMIT 20`,
    [session.email],
  );
  return {
    orders: rows.map((r) => ({
      sessionId: r.session_id,
      amountTotal: r.amount_total,
      currency: r.currency,
      paymentStatus: r.payment_status,
      shippingStatus: r.shipping_status,
      trackingNumber: r.tracking_number,
      trackingUrl: r.tracking_url,
      createdAt: r.created_at,
    })),
  };
});

const CHAT_MESSAGE_MAX = 800;

type ChatBody = { message: string; history?: { role: 'user' | 'assistant'; content: string }[] };

app.post<{ Body: ChatBody }>(
  '/api/chat',
  {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['message'],
        properties: {
          message: { type: 'string', minLength: 1, maxLength: CHAT_MESSAGE_MAX },
          history: {
            type: 'array',
            maxItems: 10,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['role', 'content'],
              properties: {
                role: { type: 'string', enum: ['user', 'assistant'] },
                content: { type: 'string', minLength: 1, maxLength: CHAT_MESSAGE_MAX },
              },
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    if (!chatConfigured()) {
      return reply.code(503).send(fail('chat_unconfigured', 'DEEPSEEK_API_KEY is not set'));
    }
    if (!allowChat(req.ip)) {
      return reply.code(429).send(fail('rate_limited', 'too many chat messages, slow down'));
    }

    try {
      // The assistant acts as whoever is chatting: anonymous callers get the read-only
      // tools, and a logged-in one gets the rest, scoped to their own account by the
      // very same routes the page uses.
      const text = await chatReply(req.body.message, req.body.history ?? [], {
        call: internalCall(req.headers.cookie),
        email: (await currentSession(req))?.email,
      });
      return { reply: text };
    } catch (err) {
      if (err instanceof ChatUnconfiguredError) {
        return reply.code(503).send(fail('chat_unconfigured', err.message));
      }
      if (err instanceof ChatUpstreamError) {
        return reply.code(502).send(fail('chat_upstream', err.message));
      }
      throw err;
    }
  },
);

// One static page. No bundler, no @fastify/static: it is a single file. The publishable
// key is safe client-side (it's the point of a *publishable* key) so it's templated in
// here rather than fetched — one less round trip before the Google button can work.
// split/join, not replaceAll: replaceAll still honors $&-style patterns in the
// replacement string, and this one lands inside a JS string literal in the page.
const page = (await readFile(new URL('../public/index.html', import.meta.url), 'utf8'))
  .split('__CLERK_PUBLISHABLE_KEY__')
  .join(process.env.CLERK_PUBLISHABLE_KEY ?? '');
for (const path of ['/', '/success', '/cancel']) {
  app.get(path, (_req, reply) => reply.type('text/html; charset=utf-8').send(page));
}

app.setNotFoundHandler((req, reply) =>
  reply.code(404).send(fail('route_not_found', `${req.method} ${req.url} is not a route`)),
);

app.setErrorHandler((err: FastifyError, _req, reply) => {
  if (err.validation) {
    return reply.code(400).send(fail('invalid_request', 'request failed validation', err.validation));
  }
  app.log.error({ err }, 'unhandled error');
  const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
  return reply.code(status).send(fail('internal_error', 'something broke on our side'));
});

await runMigrations();

// Only listen when run as the entrypoint. Importing this module used to bind a port,
// which is why no route could be covered by a test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The worker shares this process: Render has no background-worker service on the
  // free tier. See the note in src/queue.ts about hibernation.
  startWorkers(handlers, app.log);
  if (queueConfigured()) app.log.info({ }, 'queue workers started');

  // Let in-flight jobs finish instead of stranding them as stalled on a deploy.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      Promise.allSettled([closeQueues(), app.close()]).then(() => process.exit(0));
    });
  }

  app.listen({ port: env.PORT, host: '0.0.0.0' }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
