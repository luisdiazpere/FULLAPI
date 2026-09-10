import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearSessionCookie, parseSessionCookie, sessionCookie } from '../src/auth.ts';

test('round-trips a session token through the cookie header', () => {
  const cookie = sessionCookie('abc123', new Date('2030-01-01T00:00:00Z'), true);
  const header = cookie.split(';')[0]; // the client only ever echoes back "name=value"
  assert.equal(parseSessionCookie(header), 'abc123');
});

test('parses one cookie out of several', () => {
  assert.equal(parseSessionCookie('foo=bar; session=xyz; baz=qux'), 'xyz');
});

test('no cookie header, or none named session, is null', () => {
  assert.equal(parseSessionCookie(undefined), null);
  assert.equal(parseSessionCookie('foo=bar'), null);
});

test('the secure flag only appears when asked for', () => {
  assert.match(sessionCookie('t', new Date(), true), /Secure/);
  assert.doesNotMatch(sessionCookie('t', new Date(), false), /Secure/);
});

test('clearing the cookie expires it in the past', () => {
  assert.match(clearSessionCookie(false), /Expires=Thu, 01 Jan 1970/);
});
