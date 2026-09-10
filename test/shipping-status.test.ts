import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapShippoStatus } from '../src/shippingStatus.ts';

test('carrier movement and delivery are worth emailing', () => {
  assert.deepEqual(mapShippoStatus('TRANSIT'), { status: 'in_transit', emailWorthy: true });
  assert.deepEqual(mapShippoStatus('DELIVERED'), { status: 'delivered', emailWorthy: true });
  assert.deepEqual(mapShippoStatus('FAILURE'), { status: 'failed', emailWorthy: true });
  assert.deepEqual(mapShippoStatus('RETURNED'), { status: 'returned', emailWorthy: true });
});

test('pre-transit and unknown are not worth emailing', () => {
  assert.equal(mapShippoStatus('PRE_TRANSIT')?.emailWorthy, false);
  assert.equal(mapShippoStatus('UNKNOWN')?.emailWorthy, false);
});

test('an unrecognized carrier status is ignored rather than guessed at', () => {
  assert.equal(mapShippoStatus('SOMETHING_NEW'), null);
});
