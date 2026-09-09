import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minorUnits } from '../src/shipping.ts';

test('a carrier decimal string becomes integer minor units', () => {
  assert.equal(minorUnits('12.50'), 1250);
  assert.equal(minorUnits('8'), 800);
  assert.equal(minorUnits('0.05'), 5);
});

test('rounds to the cent rather than carrying a float', () => {
  assert.equal(minorUnits('12.345'), 1235);
  assert.equal(minorUnits('19.99'), 1999);
});

test('an unparseable amount is rejected, never passed on as NaN', () => {
  // A NaN would sail into a quote and be shown to a buyer as a price.
  for (const bad of ['', 'free', 'N/A', '-3.00', 'Infinity']) {
    assert.equal(minorUnits(bad), null, `expected ${bad} to be rejected`);
  }
});
