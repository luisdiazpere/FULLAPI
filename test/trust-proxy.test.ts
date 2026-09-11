import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

/**
 * Pins the trustProxy semantics src/server.ts depends on. Getting this wrong is
 * silent: req.ip quietly stays the edge's address, every visitor shares one
 * rate-limit bucket, and req.protocol never says https so the session cookie
 * loses Secure. Nothing throws, so only a test catches it.
 *
 * Must stay identical to the option in src/server.ts.
 */
const build = () => {
  const app = Fastify({ trustProxy: (_address: string, hop: number) => hop === 0 });
  app.get('/', async (req) => ({ ip: req.ip, protocol: req.protocol }));
  return app;
};

test('the client IP comes from the edge, not the socket', async () => {
  const app = build();
  const res = await app.inject({
    method: 'GET',
    url: '/',
    headers: { 'x-forwarded-for': '203.0.113.9' },
  });
  assert.equal(res.json().ip, '203.0.113.9');
  await app.close();
});

test('a forged X-Forwarded-For cannot move req.ip', async () => {
  const app = build();
  // The client wrote 1.2.3.4; Render's edge appended the address it actually saw.
  // Trusting one hop means we read the edge's entry and ignore everything left of it.
  const res = await app.inject({
    method: 'GET',
    url: '/',
    headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' },
  });
  assert.equal(res.json().ip, '203.0.113.9', 'must not be the client-supplied 1.2.3.4');
  await app.close();
});

test('req.protocol reflects the edge TLS termination, so cookies get Secure', async () => {
  const app = build();
  const res = await app.inject({
    method: 'GET',
    url: '/',
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.equal(res.json().protocol, 'https');
  await app.close();
});

test('without a forwarded header the request is treated as plain http', async () => {
  const app = build();
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.json().protocol, 'http');
  await app.close();
});
