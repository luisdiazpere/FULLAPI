import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRateLimiter } from '../src/rateLimit.ts';

test('allows up to the limit inside one window, then refuses', () => {
  const allow = makeRateLimiter(3, 1000);
  assert.equal(allow('a', 0), true);
  assert.equal(allow('a', 10), true);
  assert.equal(allow('a', 20), true);
  assert.equal(allow('a', 30), false);
});

test('keys are independent, so one caller cannot lock another out', () => {
  const allow = makeRateLimiter(1, 1000);
  assert.equal(allow('a', 0), true);
  assert.equal(allow('a', 1), false);
  assert.equal(allow('b', 1), true);
});

test('a fresh window lets the same key through again', () => {
  const allow = makeRateLimiter(1, 1000);
  assert.equal(allow('a', 0), true);
  assert.equal(allow('a', 500), false);
  assert.equal(allow('a', 1001), true);
});

/**
 * The reason this file exists: with trustProxy on, req.ip is finally distinct per
 * client, so every distinct key would otherwise be retained for the process lifetime.
 * A limiter that never forgets is a memory leak fed by unauthenticated traffic.
 */
test('expired keys are swept once a later key arrives', () => {
  const allow = makeRateLimiter(5, 1000);
  for (let i = 0; i < 1000; i += 1) allow(`ip-${i}`, 0);
  assert.equal(allow.tracked(), 1000);

  // Still inside the window: nothing may be dropped, or live callers lose their count.
  allow('inside-the-window', 500);
  assert.equal(allow.tracked(), 1001, 'entries inside their window survive a new key');

  // Past every window, and one new key arrives to trigger the sweep.
  allow('after', 2000);
  assert.equal(allow.tracked(), 1, 'only the key that triggered the sweep remains');
});
