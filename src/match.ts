import type { Country } from './countries.ts';

export type Match = { code: string; name: string; spanish: string | null; emoji: string | null };

/**
 * Lowercase, then drop accents and everything that is not a letter or digit —
 * spaces included, so "Côte d'Ivoire", "cote divoire" and "Cotedivoire" all fold
 * together. Keeping the spaces would leave "cote d ivoire", which matches nothing
 * a shopper types.
 */
export const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

const card = (c: Country): Match => ({
  code: c.code,
  name: c.name,
  spanish: c.spanish,
  emoji: c.flag.emoji,
});

/** Every name a shopper might use for one country: English, Spanish, upstream aliases. */
const namesOf = (c: Country): string[] =>
  [c.name, c.spanish, ...c.aliases].filter((n) => n !== null).map(fold);

/**
 * Resolve what a shopper typed to a country.
 *
 * Codes are matched before names, and a 2-letter query is ONLY ever a code: left
 * fuzzy, "CA" reaches "Chad" before "Canada" and the order ships to the wrong
 * continent. Anything short of an exact hit returns candidates rather than a
 * guess, so the assistant asks instead of choosing.
 */
export function matchCountry(query: string, countries: Country[]): {
  exact: Match | null;
  candidates: Match[];
} {
  const raw = query.trim();
  const key = fold(raw);
  if (!key) return { exact: null, candidates: [] };

  const code = raw.toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) {
    const hit = countries.find((c) => c.code === code);
    if (hit) return { exact: card(hit), candidates: [] };
  }
  if (/^[A-Z]{2}$/.test(code)) {
    // A real alpha-2 wins outright and stops here: "CA" must be Canada, never a
    // fuzzy reach for Chad. When it is not a code at all there is no such risk,
    // so "Ja" falls through and comes back as candidates.
    const hit = countries.find((c) => c.alpha2 === code);
    if (hit) return { exact: card(hit), candidates: [] };
  }

  const whole = countries.filter((c) => namesOf(c).includes(key));
  if (whole.length === 1) return { exact: card(whole[0]!), candidates: [] };
  if (whole.length > 1) return { exact: null, candidates: whole.map(card) };

  const starts = countries.filter((c) => namesOf(c).some((n) => n.startsWith(key)));
  const within = countries.filter(
    (c) => !starts.includes(c) && namesOf(c).some((n) => n.includes(key)),
  );
  // ponytail: prefix and substring only, no edit distance. A typo finds nothing and
  // the assistant asks again, which beats confidently resolving to the wrong country.
  return { exact: null, candidates: [...starts, ...within].slice(0, 5).map(card) };
}

/**
 * Find a country mentioned inside a sentence ("algo barato de Japón").
 *
 * Windows of three words down to one, longest first, so "Costa de Marfil" and
 * "Estados Unidos" win over any single word inside them. Single words shorter
 * than four characters are skipped: "de", "un" and a stray "CA" would otherwise
 * pull a whole order to the wrong country.
 */
export function findCountryInText(text: string, countries: Country[]): Match | null {
  const words = text.split(/\s+/).filter(Boolean);
  for (const size of [3, 2, 1]) {
    for (let i = 0; i + size <= words.length; i += 1) {
      const window = words.slice(i, i + size).join(' ');
      if (size === 1 && fold(window).length < 4) continue;
      const { exact } = matchCountry(window, countries);
      if (exact) return exact;
    }
  }
  return null;
}
