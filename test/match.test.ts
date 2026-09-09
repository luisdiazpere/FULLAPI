import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCountryInText, matchCountry } from '../src/match.ts';
import type { Country } from '../src/countries.ts';

const country = (over: Partial<Country>): Country => ({
  code: 'XXX',
  alpha2: 'XX',
  name: 'Nowhere',
  spanish: null,
  aliases: [],
  capital: null,
  currency: null,
  flag: { url: 'https://example.test/x.png', emoji: null },
  ...over,
});

const WORLD = [
  country({ code: 'JPN', alpha2: 'JP', name: 'Japan', spanish: 'Japón' }),
  country({ code: 'DEU', alpha2: 'DE', name: 'Germany', spanish: 'Alemania' }),
  country({ code: 'JAM', alpha2: 'JM', name: 'Jamaica', spanish: 'Jamaica' }),
  country({ code: 'CAN', alpha2: 'CA', name: 'Canada', spanish: 'Canadá' }),
  country({ code: 'TCD', alpha2: 'TD', name: 'Chad', spanish: 'Chad' }),
  country({ code: 'CIV', alpha2: 'CI', name: "Côte d'Ivoire", spanish: 'Costa de Marfil' }),
  country({ code: 'NLD', alpha2: 'NL', name: 'Netherlands', aliases: ['Holland'] }),
];

test('resolves the Spanish name a shopper would actually type', () => {
  assert.equal(matchCountry('Alemania', WORLD).exact?.code, 'DEU');
  assert.equal(matchCountry('japón', WORLD).exact?.code, 'JPN');
  assert.equal(matchCountry('Costa de Marfil', WORLD).exact?.code, 'CIV');
});

test('folds accents and punctuation before comparing', () => {
  assert.equal(matchCountry('cote divoire', WORLD).exact?.code, 'CIV');
  assert.equal(matchCountry('CANADA', WORLD).exact?.code, 'CAN');
});

test('matches upstream aliases', () => {
  assert.equal(matchCountry('Holland', WORLD).exact?.code, 'NLD');
});

test('codes win over names', () => {
  assert.equal(matchCountry('JPN', WORLD).exact?.code, 'JPN');
  assert.equal(matchCountry('de', WORLD).exact?.code, 'DEU');
});

test('a two-letter query is only ever a code, never a fuzzy name', () => {
  // Left fuzzy, "CA" reaches Chad before Canada and the parcel crosses an ocean.
  assert.equal(matchCountry('CA', WORLD).exact?.code, 'CAN');
  const zz = matchCountry('ZZ', WORLD);
  assert.equal(zz.exact, null);
  assert.deepEqual(zz.candidates, []);
});

test('an ambiguous prefix asks instead of guessing', () => {
  const { exact, candidates } = matchCountry('Ja', WORLD);
  assert.equal(exact, null);
  assert.deepEqual(candidates.map((c) => c.code).sort(), ['JAM', 'JPN']);
});

test('candidates never exceed five', () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    country({ code: `A${i}${i}`, alpha2: `A${i}`, name: `Alphaland ${i}` }),
  );
  assert.equal(matchCountry('Alphaland', many).candidates.length, 5);
});

test('nothing matched is an empty answer, not a wrong one', () => {
  const { exact, candidates } = matchCountry('zzzzz', WORLD);
  assert.equal(exact, null);
  assert.deepEqual(candidates, []);
});

test('finds a country inside a sentence, longest phrase first', () => {
  const world = [
    country({ code: 'JPN', alpha2: 'JP', name: 'Japan', spanish: 'Japón' }),
    country({ code: 'USA', alpha2: 'US', name: 'United States', spanish: 'Estados Unidos' }),
    country({ code: 'CIV', alpha2: 'CI', name: 'Ivory Coast', spanish: 'Costa de Marfil' }),
  ];
  assert.equal(findCountryInText('algo barato de Japón', world)?.code, 'JPN');
  assert.equal(findCountryInText('a gift from the United States', world)?.code, 'USA');
  assert.equal(findCountryInText('quiero algo de Costa de Marfil', world)?.code, 'CIV');
  assert.equal(findCountryInText('something cheap please', world), null);
});

test('short filler words never resolve a country', () => {
  // "de" and a stray "CA" must not drag an order to another continent.
  const world = [country({ code: 'CAN', alpha2: 'CA', name: 'Canada', spanish: 'Canadá' })];
  assert.equal(findCountryInText('un regalo de menos de 30', world), null);
});
