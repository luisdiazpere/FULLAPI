import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parcelFor, zoneFor, type Parcel } from '../src/parcel.ts';

const DIMS = new Map<string, Parcel>([
  ['flag-and-seal', { weightGrams: 600, lengthCm: 25, widthCm: 20, heightCm: 6 }],
  ['capital-postcards', { weightGrams: 300, lengthCm: 18, widthCm: 13, heightCm: 3 }],
]);

test('one kit, one of it, is that kit', () => {
  assert.deepEqual(parcelFor([{ kitSku: 'flag-and-seal', quantity: 1 }], DIMS), {
    weightGrams: 600, lengthCm: 25, widthCm: 20, heightCm: 6,
  });
});

test('weight sums across quantities and lines', () => {
  const p = parcelFor(
    [{ kitSku: 'flag-and-seal', quantity: 2 }, { kitSku: 'capital-postcards', quantity: 1 }],
    DIMS,
  );
  assert.equal(p.weightGrams, 600 * 2 + 300);
});

test('footprint takes the largest kit, height stacks', () => {
  const p = parcelFor(
    [{ kitSku: 'flag-and-seal', quantity: 2 }, { kitSku: 'capital-postcards', quantity: 1 }],
    DIMS,
  );
  assert.equal(p.lengthCm, 25);
  assert.equal(p.widthCm, 20);
  assert.equal(p.heightCm, 6 * 2 + 3);
});

test('an unknown kit throws instead of quoting a NaN parcel', () => {
  assert.throws(
    () => parcelFor([{ kitSku: 'nope', quantity: 1 }], DIMS),
    /no parcel dimensions for kit nope/,
  );
});

test('zones cover the world and exclude what we will not ship', () => {
  assert.equal(zoneFor('USA')?.zone, 'north-america');
  assert.equal(zoneFor('deu')?.zone, 'europe');
  assert.equal(zoneFor('JPN')?.zone, 'rest-of-world');
  assert.equal(zoneFor('PRK'), null);
});
