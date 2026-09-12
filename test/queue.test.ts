import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { QUEUE_NAMES, enqueue, queue, queueConfigured } from '../src/queue.ts';

/**
 * The queue is optional on purpose. Without REDIS_URL the shop must still take
 * orders, with the work running inline instead — so the unconfigured path is the
 * one worth pinning: if it ever throws instead of returning null, a missing Redis
 * turns into a failed checkout.
 */
const original = process.env.REDIS_URL;
afterEach(() => {
  if (original === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = original;
});

test('queueConfigured follows REDIS_URL', () => {
  delete process.env.REDIS_URL;
  assert.equal(queueConfigured(), false);
  process.env.REDIS_URL = 'redis://localhost:6380';
  assert.equal(queueConfigured(), true);
});

test('with no REDIS_URL there is no queue, and asking for one does not throw', () => {
  delete process.env.REDIS_URL;
  for (const name of QUEUE_NAMES) {
    assert.equal(queue(name), null, `${name} must be null, never a half-built Queue`);
  }
});

test('enqueue reports "not queued" rather than failing when there is no Redis', async () => {
  delete process.env.REDIS_URL;
  // null is the signal runOrQueue uses to fall back to running the work inline.
  assert.equal(await enqueue('email', 'welcome', { kind: 'welcome', to: 'a@b.c' }), null);
});

test('both queues the app relies on are declared', () => {
  assert.deepEqual([...QUEUE_NAMES], ['email', 'shipping']);
});
