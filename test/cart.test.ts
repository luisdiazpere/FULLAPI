import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdPlan } from '../src/cart.ts';

test('sums one kit across the countries it was added for', () => {
  assert.deepEqual(
    holdPlan([
      { kitSku: 'flag-and-seal', countryCode: 'JPN', quantity: 2 },
      { kitSku: 'flag-and-seal', countryCode: 'FRA', quantity: 3 },
    ]),
    [['flag-and-seal', 5]],
  );
});

test('orders holds by sku so concurrent carts cannot deadlock', () => {
  const one = holdPlan([
    { kitSku: 'currency-coin-frame', countryCode: 'JPN', quantity: 1 },
    { kitSku: 'capital-postcards', countryCode: 'JPN', quantity: 1 },
  ]);
  const other = holdPlan([
    { kitSku: 'capital-postcards', countryCode: 'FRA', quantity: 1 },
    { kitSku: 'currency-coin-frame', countryCode: 'FRA', quantity: 1 },
  ]);
  assert.deepEqual(one.map(([sku]) => sku), other.map(([sku]) => sku));
});
