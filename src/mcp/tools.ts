import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { holdPlan } from '../cart.ts';
import type { Country } from '../countries.ts';
import { findCountryInText, matchCountry } from '../match.ts';
import { shop, postJson, toolError } from './shop.ts';

const COUNTRY_CODE = z.string().regex(/^[A-Za-z]{2,3}$/, 'alpha-2 or alpha-3 country code');
const KIT_SKU = z.string().regex(/^[a-z0-9-]{1,64}$/, 'kit sku');

/** Same bounds the checkout schema enforces, so a cart that passes here is one it accepts. */
const CART_ITEMS = z
  .array(
    z.object({
      kitSku: KIT_SKU,
      countryCode: COUNTRY_CODE,
      quantity: z.number().int().min(1).max(10).default(1),
    }),
  )
  .min(1)
  .max(20);

type CartItem = { kitSku: string; countryCode: string; quantity: number };
type KitRow = {
  sku: string;
  unitAmount: number;
  currency: string;
  stock: number;
  nameTemplate?: string;
  descriptionTemplate?: string;
  name?: string;
  description?: string;
  image?: string | null;
  purchasable?: boolean;
  unavailableReason?: string | null;
};

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const failed = (err: unknown) => ({
  content: [{ type: 'text' as const, text: toolError(err) }],
  isError: true,
});

/** The catalogue is 250 rows and changes daily at most; refetching it per tool call is waste. */
let countryCache: { at: number; rows: Country[] } | null = null;
async function countries(): Promise<Country[]> {
  if (countryCache && Date.now() - countryCache.at < 60 * 60 * 1000) return countryCache.rows;
  const rows = await shop<Country[]>('/api/countries');
  countryCache = { at: Date.now(), rows };
  return rows;
}

const firstSentence = (text: string): string => {
  const cut = text.match(/^.*?[.!?](\s|$)/)?.[0]?.trim();
  return cut && cut.length < text.length ? cut : text;
};

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'bandera-y-sello', version: '0.1.0' },
    {
      instructions: [
        'Souvenir shop: four kit types, each sold for any of ~250 countries.',
        'Country codes are alpha-3. Shoppers write country names in Spanish or English —',
        'always call resolve_country first and use the code it returns.',
        'Prices are integer minor units with an explicit currency (1800 usd = $18.00).',
        'create_payment_link holds real stock the moment it is called and nothing releases it,',
        'so call validate_cart first and only create a link once the shopper has said yes.',
      ].join(' '),
    },
  );

  server.registerTool(
    'resolve_country',
    {
      title: 'Resolve a country name to a code',
      description:
        'Turn whatever the shopper called a country ("Alemania", "Japon", "JP") into the alpha-3 '
        + 'code every other tool needs. Call this before any tool that takes a countryCode. '
        + 'Returns candidates instead of a guess when the name is ambiguous — ask the shopper which.',
      inputSchema: { query: z.string().min(1).max(80).describe('The country as the shopper wrote it') },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ query }) => {
      try {
        const { exact, candidates } = matchCountry(query, await countries());
        if (exact) return json({ found: true, ...exact });
        if (candidates.length) {
          return json({
            found: false,
            ambiguous: true,
            candidates,
            hint: 'Ask the shopper which one they meant, then call again with the alpha-3 code.',
          });
        }
        return json({
          found: false,
          ambiguous: false,
          hint: `No country matches "${query}". Ask the shopper to spell it or give a 2 or 3 letter code.`,
        });
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    'list_kits',
    {
      title: 'List the kit types',
      description:
        'The four kit types the shop sells, with price and stock. These are the only products '
        + 'that exist — never describe a kit that is not in this list. Prices and stock are the '
        + 'same for every country; only the name and the flag change.',
      inputSchema: {
        verbose: z
          .boolean()
          .default(false)
          .describe('Include the name/description templates. Only useful when asked what is in a kit.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ verbose }) => {
      try {
        const kits = await shop<KitRow[]>('/api/kits');
        return json(
          kits.map((k) => ({
            sku: k.sku,
            unitAmount: k.unitAmount,
            currency: k.currency,
            stock: k.stock,
            ...(verbose
              ? { nameTemplate: k.nameTemplate, descriptionTemplate: k.descriptionTemplate }
              : {}),
          })),
        );
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    'list_catalog',
    {
      title: 'List every kit for one country',
      description:
        'The four kits rendered for one country, with the real name, price, stock and whether each '
        + 'can actually be bought. Use this when you already have a country code. If the shopper '
        + 'described what they want in words instead, use search_catalog.',
      inputSchema: {
        countryCode: COUNTRY_CODE.describe('Alpha-3 code from resolve_country'),
        verbose: z.boolean().default(false).describe('Full descriptions and flag image URLs'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ countryCode, verbose }) => {
      try {
        const kits = await shop<KitRow[]>(`/api/kits?country=${encodeURIComponent(countryCode)}`);
        return json({
          countryCode: countryCode.toUpperCase(),
          kits: kits.map((k) => ({
            sku: k.sku,
            name: k.name,
            unitAmount: k.unitAmount,
            currency: k.currency,
            purchasable: k.purchasable,
            unavailableReason: k.unavailableReason,
            description: verbose ? k.description : firstSentence(k.description ?? ''),
            ...(verbose ? { image: k.image } : {}),
          })),
        });
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    'search_catalog',
    {
      title: 'Search the catalogue in words',
      description:
        'Find kits from a free-text wish ("something cheap from Japan", "a gift under 30 dollars"). '
        + 'Resolves a country out of the text when there is one. Do not use this if you already '
        + 'have a country code — use list_catalog, which is exact.',
      inputSchema: {
        query: z.string().min(2).max(200).describe('What the shopper asked for, in their words'),
        maxUnitAmount: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Price ceiling in minor units (3000 = $30.00)'),
        inStockOnly: z.boolean().default(true),
        limit: z.number().int().min(1).max(10).default(5),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, maxUnitAmount, inStockOnly, limit }) => {
      try {
        const exact = findCountryInText(query, await countries());
        const kits = exact
          ? await shop<KitRow[]>(`/api/kits?country=${encodeURIComponent(exact.code)}`)
          : await shop<KitRow[]>('/api/kits');

        const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
        const scored = kits
          .filter((k) => (maxUnitAmount ? k.unitAmount <= maxUnitAmount : true))
          .filter((k) => (inStockOnly ? k.stock > 0 : true))
          .map((k) => {
            const hay = `${k.sku} ${k.name ?? ''} ${k.description ?? ''}`.toLowerCase();
            return { k, score: words.filter((w) => hay.includes(w)).length };
          })
          .sort((a, b) => b.score - a.score || a.k.unitAmount - b.k.unitAmount);

        const shown = scored.slice(0, limit);
        return json({
          resolvedCountry: exact ? { code: exact.code, name: exact.name } : null,
          matched: scored.length,
          returned: shown.length,
          ...(scored.length > shown.length
            ? { hint: 'More matched than shown. Narrow with maxUnitAmount or a country.' }
            : {}),
          ...(exact ? {} : { note: 'No country in the query — prices and stock shown are the same for every country.' }),
          kits: shown.map(({ k }) => ({
            sku: k.sku,
            name: k.name ?? k.nameTemplate ?? k.sku,
            unitAmount: k.unitAmount,
            currency: k.currency,
            purchasable: k.purchasable ?? k.stock > 0,
            description: firstSentence(k.description ?? k.descriptionTemplate ?? ''),
          })),
        });
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    'validate_cart',
    {
      title: 'Check an order before paying for it',
      description:
        'Dry-run an order: stock (summed per kit across every country that uses it), whether each '
        + 'kit can be made for its country, and currency. Holds nothing and creates nothing. '
        + 'Always call this before create_payment_link.',
      inputSchema: { items: CART_ITEMS },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ items }) => {
      try {
        const lines = items as CartItem[];
        const problems: Record<string, unknown>[] = [];

        // The same function checkout itself calls (src/server.ts:257). Reimplementing
        // the per-sku summing is exactly how a dry run drifts from the real thing.
        const plan = holdPlan(lines);
        const kits = await shop<KitRow[]>('/api/kits');
        const bySku = new Map(kits.map((k) => [k.sku, k]));

        for (const [sku, wanted] of plan) {
          const kit = bySku.get(sku);
          if (!kit) {
            problems.push({ kind: 'unknown_kit', kitSku: sku });
          } else if (wanted > kit.stock) {
            problems.push({
              kind: 'insufficient_stock',
              kitSku: sku,
              stock: kit.stock,
              requested: wanted,
              short: wanted - kit.stock,
            });
          }
        }

        for (const code of new Set(lines.map((l) => l.countryCode.toUpperCase()))) {
          const rendered = await shop<KitRow[]>(`/api/kits?country=${encodeURIComponent(code)}`);
          const wanted = new Set(
            lines.filter((l) => l.countryCode.toUpperCase() === code).map((l) => l.kitSku),
          );
          for (const kit of rendered) {
            if (!wanted.has(kit.sku)) continue;
            if (!kit.purchasable && kit.unavailableReason && kit.unavailableReason !== 'out of stock') {
              problems.push({
                kind: 'not_renderable',
                kitSku: kit.sku,
                countryCode: code,
                reason: kit.unavailableReason,
              });
            }
          }
        }

        const currencies = [...new Set(plan.map(([sku]) => bySku.get(sku)?.currency).filter(Boolean))];
        if (currencies.length > 1) problems.push({ kind: 'mixed_currency', currencies });

        const total = lines.reduce((sum, l) => sum + (bySku.get(l.kitSku)?.unitAmount ?? 0) * l.quantity, 0);
        return json({
          ok: problems.length === 0,
          problems,
          total: { amount: total, currency: currencies[0] ?? null },
          note: 'Nothing is reserved. Stock can still go between here and create_payment_link.',
        });
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    'check_shipping',
    {
      title: 'Quote shipping to a country',
      description:
        'Live carrier rates for delivering an order to one country. Returns serviceable:false with '
        + 'a reason when we do not ship there — that is an answer, say it plainly. '
        + 'IMPORTANT: this is an estimate only. Checkout charges for the kits and does not collect '
        + 'shipping or a delivery address, so never add this to the order total as if it were charged.',
      inputSchema: {
        countryCode: COUNTRY_CODE.describe('Alpha-3 code from resolve_country'),
        items: CART_ITEMS,
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ countryCode, items }) => {
      try {
        const pairs = (items as CartItem[]).map((i) => `${i.kitSku}:${i.quantity}`).join(',');
        const query = new URLSearchParams({ country: countryCode, items: pairs });
        return json(await shop(`/api/shipping/quote?${query}`));
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    'list_shipping_destinations',
    {
      title: 'Where the shop ships',
      description:
        'The shipping zones, the methods each offers, and the countries we will not ship to at all.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return json(await shop('/api/shipping/destinations'));
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    'create_payment_link',
    {
      title: 'Create a Stripe checkout link',
      description:
        'Creates a real Stripe Checkout session and IMMEDIATELY HOLDS STOCK, which is never '
        + 'released if the shopper walks away. Call validate_cart first, and only call this once '
        + 'the shopper has explicitly said they want to pay. Returns a URL for them to open; '
        + 'payment is not complete until check_payment_status says so.',
      inputSchema: { items: CART_ITEMS },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ items }) => {
      try {
        const created = await shop<{
          sessionId: string;
          url: string;
          amountTotal: number;
          currency: string;
          items: { kitSku: string; countryCode: string; quantity: number; name: string }[];
        }>('/api/checkout', postJson({ items }));
        return json({
          sessionId: created.sessionId,
          url: created.url,
          amountTotal: created.amountTotal,
          currency: created.currency,
          items: created.items.map((i) => ({
            kitSku: i.kitSku,
            countryCode: i.countryCode,
            quantity: i.quantity,
            name: i.name,
          })),
          next: 'Give the shopper the url, then poll check_payment_status with the sessionId.',
        });
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    'check_payment_status',
    {
      title: 'Check whether a payment went through',
      description:
        'Read the current state of a checkout session. Poll this after handing over a payment link. '
        + 'Stop polling once paymentStatus is "paid" or the session is expired — it will not change '
        + 'again on its own.',
      inputSchema: {
        sessionId: z
          .string()
          .regex(/^cs_[A-Za-z0-9_]{10,200}$/, 'a Stripe checkout session id, starting cs_')
          .describe('The sessionId create_payment_link returned'),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ sessionId }) => {
      try {
        return json(await shop(`/api/checkout/${encodeURIComponent(sessionId)}`));
      } catch (err) {
        return failed(err);
      }
    },
  );

  return server;
}
