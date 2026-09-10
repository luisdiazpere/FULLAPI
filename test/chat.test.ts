import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowChat } from '../src/chat.ts';

test('allows up to the limit, then blocks within the same window', () => {
  const ip = '203.0.113.1';
  const start = 1_000_000;
  for (let i = 0; i < 10; i += 1) assert.equal(allowChat(ip, start + i), true);
  assert.equal(allowChat(ip, start + 10), false);
});

test('resets once the window has passed', () => {
  const ip = '203.0.113.2';
  const start = 2_000_000;
  for (let i = 0; i < 10; i += 1) allowChat(ip, start + i);
  assert.equal(allowChat(ip, start), false);
  assert.equal(allowChat(ip, start + 60_000 + 1), true);
});

test('one IP being rate limited does not affect another', () => {
  const start = 3_000_000;
  for (let i = 0; i < 10; i += 1) allowChat('203.0.113.3', start + i);
  assert.equal(allowChat('203.0.113.3', start + 10), false);
  assert.equal(allowChat('203.0.113.4', start + 10), true);
});
