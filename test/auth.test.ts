import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth.ts';

test('a password verifies against its own hash', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', stored), true);
});

test('the wrong password fails', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('wrong password', stored), false);
});

test('two hashes of the same password differ (random salt)', () => {
  const a = hashPassword('same password');
  const b = hashPassword('same password');
  assert.notEqual(a, b);
});

test('a malformed stored hash fails closed rather than throwing', () => {
  assert.equal(verifyPassword('anything', 'not-a-real-hash'), false);
});
