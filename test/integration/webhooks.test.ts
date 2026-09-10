import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import Stripe from 'stripe';
import { pool } from '../../src/db.ts';
import { runMigrations } from '../../src/migrate.ts';
import { alreadyProcessed, releaseProcessed } from '../../src/orders.ts';
import webhooks from '../../src/webhooks.ts';

// Real Postgres, not a fake pool: the thing worth protecting is the SQL
// semantics (an atomic claim, a real DELETE releasing it), which a fake
// would only assert we called our own functions in the right order — the
// exact assertion that stayed true while the original bug (FULLAPI-25m)
// was live. See scripts/test-integration.sh for the scratchtest lifecycle;
// this file assumes DATABASE_URL already points at it.
await runMigrations();

const app = Fastify({ logger: false });
await app.register(webhooks);
await app.ready();

after(async () => {
  await app.close();
  await pool.end();
});

test('alreadyProcessed claims on the first call, reports already-claimed on the second', async () => {
  const id = `evt_claim_${Date.now()}`;
  assert.equal(await alreadyProcessed(id, 'test'), false);
  assert.equal(await alreadyProcessed(id, 'test'), true);
});

test('releaseProcessed makes a claimed event claimable again', async () => {
  const id = `evt_release_${Date.now()}`;
  assert.equal(await alreadyProcessed(id, 'test'), false);
  await releaseProcessed(id);
  assert.equal(await alreadyProcessed(id, 'test'), false);
});

test('a handler that throws leaves the event retryable, not silently swallowed', async () => {
  const eventId = `evt_stripe_fail_${Date.now()}`;
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    // A session id Stripe's test API has never heard of: loadSession() -> a real,
    // read-only "resource_missing" call to Stripe -> handleCheckoutCompleted throws.
    data: { object: { id: 'cs_test_does_not_exist_xyz' } },
  });
  const signature = new Stripe(process.env.STRIPE_SECRET_KEY!).webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET!,
  });
  const headers = { 'content-type': 'application/json', 'stripe-signature': signature };

  const first = await app.inject({ method: 'POST', url: '/api/webhooks/stripe', headers, payload });
  assert.notEqual(first.statusCode, 200);

  // The actual regression: under the old mark-before-work code, this second,
  // identical delivery would come back 200 {duplicate:true} and never retry.
  const second = await app.inject({ method: 'POST', url: '/api/webhooks/stripe', headers, payload });
  assert.notEqual(second.statusCode, 200);
  assert.notEqual(second.json().duplicate, true);
});

test('a handler that succeeds leaves the claim standing and dedupes on redelivery', async () => {
  const sessionId = `cs_test_scratch_${Date.now()}`;
  const eventId = `evt_shippo_ok_${Date.now()}`;

  // last_shipping_email_status already matches the incoming status, so
  // applyTrackingUpdate's shouldEmail is false — success with no Brevo/network
  // dependency, keeping this test deterministic.
  await pool.query(
    `INSERT INTO orders (session_id, email, payment_status, shipping_status, last_shipping_email_status)
     VALUES ($1, 'buyer@example.com', 'paid', 'label_created', 'in_transit')`,
    [sessionId],
  );

  const payload = JSON.stringify({
    event: 'track_updated',
    data: { metadata: sessionId, tracking_status: { object_id: eventId, status: 'TRANSIT' } },
  });
  const url = `/api/webhooks/shippo?token=${process.env.SHIPPO_WEBHOOK_TOKEN}`;
  const headers = { 'content-type': 'application/json' };

  const first = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(first.statusCode, 200);
  assert.notEqual(first.json().duplicate, true);

  const second = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().duplicate, true);
});
