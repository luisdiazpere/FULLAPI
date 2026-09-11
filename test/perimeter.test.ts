import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';

process.env.ALLOWED_ORIGINS = 'https://shop.example';
const { default: perimeter, csrfFor, internalHeaders } = await import('../src/perimeter.ts');

const SESSION = 'a'.repeat(64);
const COOKIE = `session=${SESSION}`;

let app: FastifyInstance;

before(async () => {
  app = Fastify({ logger: false });
  await perimeter(app);
  app.get('/api/kits', async () => ({ ok: true }));
  app.post('/api/checkout', async () => ({ ok: true }));
  app.get('/', async () => 'page');
  await app.ready();
});

after(() => app.close());

test('a same-origin read from the page is allowed', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/kits',
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(res.statusCode, 200);
});

test('a read with no Sec-Fetch-Site is refused — that is not a browser', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/kits' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'forbidden');
});

test('a cross-site read is refused', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/kits',
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(res.statusCode, 403);
});

test('typing an API url into the address bar is refused', async () => {
  // A top-level navigation reports 'none', which is a person, not the frontend.
  const res = await app.inject({
    method: 'GET',
    url: '/api/kits',
    headers: { 'sec-fetch-site': 'none' },
  });
  assert.equal(res.statusCode, 403);
});

test('the HTML page itself is never gated — it is entered by navigation', async () => {
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
});

test('a mutation from another origin is refused', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/checkout',
    headers: { origin: 'https://evil.example', cookie: COOKIE, 'x-csrf-token': csrfFor(SESSION) },
  });
  assert.equal(res.statusCode, 403);
});

test('a mutation with no Origin at all is refused', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/checkout' });
  assert.equal(res.statusCode, 403);
});

test('a logged-in mutation without the CSRF header is refused', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/checkout',
    headers: { origin: 'https://shop.example', cookie: COOKIE },
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().error.message, /CSRF/);
});

test('a CSRF token minted for a different session is refused', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/checkout',
    headers: {
      origin: 'https://shop.example',
      cookie: COOKIE,
      'x-csrf-token': csrfFor('b'.repeat(64)),
    },
  });
  assert.equal(res.statusCode, 403);
});

test('a logged-in mutation with the matching CSRF token is allowed', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/checkout',
    headers: { origin: 'https://shop.example', cookie: COOKIE, 'x-csrf-token': csrfFor(SESSION) },
  });
  assert.equal(res.statusCode, 200);
});

test('an anonymous mutation needs only a good Origin — no credential to protect yet', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/checkout',
    headers: { origin: 'https://shop.example' },
  });
  assert.equal(res.statusCode, 200);
});

test('the CSRF token is not the session token, so the readable cookie leaks nothing', () => {
  assert.notEqual(csrfFor(SESSION), SESSION);
  assert.equal(csrfFor(SESSION), csrfFor(SESSION), 'must be stable across requests');
});

test('internalHeaders satisfies the perimeter it is paired with', async () => {
  const read = await app.inject({
    method: 'GET',
    url: '/api/kits',
    headers: internalHeaders(COOKIE),
  });
  assert.equal(read.statusCode, 200);

  const write = await app.inject({
    method: 'POST',
    url: '/api/checkout',
    headers: internalHeaders(COOKIE),
  });
  assert.equal(write.statusCode, 200, 'the in-process caller must not be locked out by the wall');
});
