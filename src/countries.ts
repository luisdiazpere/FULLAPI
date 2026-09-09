import { env } from './env.ts';

export class UpstreamError extends Error {}

export type Country = {
  code: string; // alpha-3
  alpha2: string;
  name: string;
  // Shoppers ask for "Alemania", not "Germany". Spelling-distance matching never
  // gets there, so the Spanish name and any aliases come from upstream instead.
  spanish: string | null;
  aliases: string[];
  capital: string | null;
  currency: { code: string; name: string; symbol: string | null } | null;
  flag: { url: string; emoji: string | null };
};

// Narrowed on purpose: the default `flag` object ships a colour palette per country.
const FIELDS =
  'names.common,names.alternates,names.translations.spa.common,' +
  'codes.alpha_2,codes.alpha_3,capitals.name,currencies,flag.url_png,flag.emoji';
const PAGE_SIZE = 100; // free plan ceiling; paid plans allow up to 500
const MAX_PAGES = 20;
const TTL_MS = 24 * 60 * 60 * 1000;

let cache: { at: number; byCode: Map<string, Country> } | null = null;
let inflight: Promise<Map<string, Country>> | null = null;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

type RawCountry = {
  names?: {
    common?: string;
    alternates?: string[];
    translations?: { spa?: { common?: string } };
  };
  codes?: { alpha_2?: string; alpha_3?: string };
  capitals?: { name?: string }[];
  currencies?: { code?: string; name?: string; symbol?: string }[];
  flag?: { url_png?: string; emoji?: string };
};

function normalize(raw: RawCountry): Country | null {
  const code = str(raw?.codes?.alpha_3)?.toUpperCase();
  const name = str(raw?.names?.common);
  const url = str(raw?.flag?.url_png);
  // Partially-recognised territories come back with blank codes and no flag. Skip them.
  if (!code || !name || !url) return null;

  const currency = raw.currencies?.find((c) => str(c?.code));
  return {
    code,
    alpha2: str(raw?.codes?.alpha_2)?.toUpperCase() ?? '',
    name,
    spanish: str(raw?.names?.translations?.spa?.common),
    aliases: (raw?.names?.alternates ?? []).map(str).filter((a) => a !== null),
    capital: str(raw.capitals?.[0]?.name),
    currency: currency
      ? {
          code: currency.code!.toUpperCase(),
          name: str(currency.name) ?? currency.code!,
          symbol: str(currency.symbol),
        }
      : null,
    flag: { url, emoji: str(raw?.flag?.emoji) },
  };
}

async function page(offset: number): Promise<{ objects: unknown[]; more: boolean }> {
  const url = `${env.COUNTRIES_API_URL}?response_fields=${FIELDS}&limit=${PAGE_SIZE}&offset=${offset}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${env.COUNTRIES_API_KEY}`, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  }).catch((cause) => {
    throw new UpstreamError('countries api unreachable', { cause });
  });

  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    const detail = body?.errors?.[0]?.message ?? `http ${res.status}`;
    throw new UpstreamError(`countries api rejected the request: ${detail}`);
  }

  const objects = body?.data?.objects;
  if (!Array.isArray(objects)) throw new UpstreamError('countries api returned an unexpected payload');
  return { objects, more: Boolean(body?.data?.meta?.more) };
}

async function load(): Promise<Map<string, Country>> {
  const byCode = new Map<string, Country>();
  for (let i = 0, offset = 0; i < MAX_PAGES; i++) {
    const { objects, more } = await page(offset);
    for (const raw of objects) {
      const c = normalize(raw as RawCountry);
      if (c) byCode.set(c.code, c);
    }
    if (!more || !objects.length) break;
    offset += objects.length;
  }
  if (!byCode.size) throw new UpstreamError('countries api returned no usable countries');
  return byCode;
}

// ponytail: in-process cache. Swap for Redis only if this runs on more than one instance.
async function catalog(): Promise<Map<string, Country>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.byCode;
  inflight ??= load()
    .then((byCode) => {
      cache = { at: Date.now(), byCode };
      return byCode;
    })
    .finally(() => {
      inflight = null;
    });
  try {
    return await inflight;
  } catch (err) {
    if (cache) return cache.byCode; // serve stale rather than fail the sale
    throw err;
  }
}

export async function listCountries(): Promise<Country[]> {
  return [...(await catalog()).values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Accepts alpha-2 or alpha-3; returns null when no country matches. */
export async function findCountry(code: string): Promise<Country | null> {
  const wanted = code.toUpperCase();
  const byCode = await catalog();
  if (wanted.length === 3) return byCode.get(wanted) ?? null;
  for (const c of byCode.values()) if (c.alpha2 === wanted) return c;
  return null;
}
