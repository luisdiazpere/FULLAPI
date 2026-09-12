import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { stripe, loadSession } from './stripeClient.ts';
import {
  alreadyProcessed,
  applyTrackingUpdate,
  recordPayment,
  releaseProcessed,
} from './orders.ts';
import { mapShippoStatus } from './shippingStatus.ts';
import { runOrQueue } from './jobs.ts';

const fail = (code: string, message: string) => ({ error: { code, message } });

type ShippoTrackPayload = {
  event?: string;
  data?: {
    metadata?: string;
    tracking_status?: { object_id?: string; status?: string };
  };
};

/**
 * Both webhooks in one plugin so the raw-body content-type parser below is
 * scoped to this Fastify context only — every other route in the app keeps
 * Fastify's default JSON body parsing (server.ts registers this plugin once).
 */
export default async function webhooks(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/api/webhooks/stripe', async (req, reply) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return reply.code(503).send(fail('webhook_unconfigured', 'STRIPE_WEBHOOK_SECRET is not set'));

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body as Buffer,
        req.headers['stripe-signature'] as string,
        secret,
      );
    } catch (err) {
      req.log.warn({ err }, 'stripe webhook signature check failed');
      return reply.code(400).send(fail('invalid_signature', 'signature verification failed'));
    }

    if (await alreadyProcessed(event.id, 'stripe')) {
      return reply.code(200).send({ received: true, duplicate: true });
    }

    if (event.type === 'checkout.session.completed') {
      try {
        await handleCheckoutCompleted((event.data.object as Stripe.Checkout.Session).id, req.log);
      } catch (err) {
        // The claim above already committed; release it so Stripe's retry of this
        // same event id redoes the work instead of hitting {duplicate:true} forever.
        await releaseProcessed(event.id);
        throw err;
      }
    }

    return reply.code(200).send({ received: true });
  });

  app.post<{ Querystring: { token?: string } }>('/api/webhooks/shippo', async (req, reply) => {
    const expected = process.env.SHIPPO_WEBHOOK_TOKEN;
    if (!expected) return reply.code(503).send(fail('webhook_unconfigured', 'SHIPPO_WEBHOOK_TOKEN is not set'));
    if (req.query.token !== expected) return reply.code(401).send(fail('invalid_token', 'bad webhook token'));

    let payload: ShippoTrackPayload;
    try {
      payload = JSON.parse((req.body as Buffer).toString('utf8'));
    } catch {
      return reply.code(400).send(fail('invalid_body', 'body is not JSON'));
    }

    const eventId = payload.data?.tracking_status?.object_id;
    const sessionId = payload.data?.metadata;
    const rawStatus = payload.data?.tracking_status?.status;
    if (!eventId || await alreadyProcessed(eventId, 'shippo')) {
      return reply.code(200).send({ received: true, duplicate: true });
    }

    if (payload.event === 'track_updated' && sessionId && rawStatus) {
      try {
        await handleTrackingUpdate(sessionId, rawStatus, req.log);
      } catch (err) {
        await releaseProcessed(eventId);
        throw err;
      }
    }

    return reply.code(200).send({ received: true });
  });
}

async function handleCheckoutCompleted(sessionId: string, log: FastifyBaseLogger) {
  const loaded = await loadSession(sessionId);
  const shippingDetails = loaded.session.shipping_details;

  const order = await recordPayment({
    sessionId,
    email: loaded.email,
    amountTotal: loaded.amountTotal,
    currency: loaded.currency,
    shippingAddress: shippingDetails?.address ?? null,
  });

  // Payment is recorded above, synchronously, so an order can never be lost to a
  // queue. Everything after it is a retryable side effect and goes to a worker:
  // this handler used to block for 120s on a dead SMTP port and hand Stripe a 500.
  if (!order.payment_email_sent_at && order.email) {
    await runOrQueue('email', { kind: 'payment-confirmation', sessionId }, log);
  }

  if (!shippingDetails?.address?.country) {
    log.error({ sessionId }, 'no shipping address on session, cannot purchase a label');
    return;
  }

  await runOrQueue('shipping', { kind: 'purchase-label', sessionId }, log);
}

async function handleTrackingUpdate(sessionId: string, rawStatus: string, log: FastifyBaseLogger) {
  const mapped = mapShippoStatus(rawStatus);
  if (!mapped) return;

  const result = await applyTrackingUpdate(sessionId, mapped);
  if (!result) {
    log.error({ sessionId }, 'tracking update for an unknown order');
    return;
  }

  if (result.shouldEmail && result.order.email) {
    await runOrQueue('email', {
      kind: 'shipping-status',
      sessionId,
      to: result.order.email,
      trackingNumber: result.order.tracking_number,
      status: mapped.status,
    }, log);
  }
}
