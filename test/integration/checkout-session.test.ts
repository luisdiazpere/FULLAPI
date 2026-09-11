import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.ts';
import { createSession } from '../../src/sessions.ts';
import { stripe } from '../../src/stripeClient.ts';
import { app } from '../../src/server.ts';

/**
 * GET /api/checkout/:sessionId used to answer anyone holding the id, and answered
 * with the buyer's email address. The id is not a secret — it rides in the
 * /success?session_id= URL and sits in every confirmation email — and /api/chat is
 * open to anonymous visitors with a tool that reads this route, so the leak had a
 * self-service path. These tests pin the fix.
 *
 * Real Postgres and a real Stripe test-mode session: the thing being checked is that
 * the owner comparison matches what Stripe actually returns, which a stub would
 * assert into existence rather than verify. See scripts/test-integration.sh.
 */
// Every request below sends Sec-Fetch-Site the way a browser does: /api/* is closed
// to anything that does not (src/perimeter.ts), and omitting it here would test the
// wall rather than the ownership check underneath it.
const BROWSER = { 'sec-fetch-site': 'same-origin' } as const;

const OWNER = `owner-${Date.now()}@example.invalid`;
const STRANGER = `stranger-${Date.now()}@example.invalid`;

let ownerCookie: string;
let strangerCookie: string;
let sessionId: string;

before(async () => {
  await app.ready();

  const owner = await createSession(OWNER);
  const stranger = await createSession(STRANGER);
  ownerCookie = `session=${owner.token}`;
  strangerCookie = `session=${stranger.token}`;

  // customer_email is what the route treats as ownership, and it is what
  // POST /api/checkout sets from the logged-in account.
  const created = await stripe.checkout.sessions.create({
    mode: 'payment',
    success_url: 'https://example.invalid/success',
    cancel_url: 'https://example.invalid/cancel',
    customer_email: OWNER,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: 1800,
        product_data: { name: 'Ownership check fixture' },
      },
    }],
  });
  sessionId = created.id;
});

after(async () => {
  await pool.query('DELETE FROM sessions WHERE email = ANY($1)', [[OWNER, STRANGER]]);
  await app.close();
  await pool.end();
});

test('the buyer can read their own checkout session', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/checkout/${sessionId}`,
    headers: { ...BROWSER, cookie: ownerCookie },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().email, OWNER);
});

test('a logged-in stranger holding the id gets 404, not the buyer email', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/checkout/${sessionId}`,
    headers: { ...BROWSER, cookie: strangerCookie },
  });
  // 404 rather than 403 on purpose: a 403 would confirm the id is real.
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'session_not_found');
  assert.ok(!JSON.stringify(res.json()).includes(OWNER), 'must not leak the buyer email');
});

test('an anonymous caller is refused before Stripe is ever consulted', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/checkout/${sessionId}`, headers: BROWSER });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'auth_required');
});

test('a session that does not exist is indistinguishable from one you do not own', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/checkout/cs_test_does_not_exist_xyz_0123456789',
    headers: { ...BROWSER, cookie: ownerCookie },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'session_not_found');
});
