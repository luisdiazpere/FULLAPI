import type { FastifyInstance } from 'fastify';
import { verifyWebhook, type WebhookEvent } from '@clerk/backend/webhooks';
import { pool } from './db.ts';
import { sendWelcomeEmail } from './email.ts';
import { primaryEmail } from './clerkUser.ts';

const fail = (code: string, message: string) => ({ error: { code, message } });

async function alreadyHandled(svixId: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM processed_webhook_events WHERE id = $1', [svixId]);
  return rows.length > 0;
}

// ponytail: check-then-mark instead of orders.ts's atomic INSERT ON CONFLICT
// leaves a narrow race where two near-simultaneous Clerk retries both pass
// the check and both send the email — a harmless duplicate welcome email,
// traded deliberately against the real bug (marking processed before the
// send meant a failed send could never be retried). Close the race with a
// unique constraint + catch if duplicate sends turn out to matter.
async function markHandled(svixId: string): Promise<void> {
  await pool.query(
    'INSERT INTO processed_webhook_events (id, source) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [svixId, 'clerk'],
  );
}

/**
 * Clerk (via Svix) signs each delivery with svix-id/-timestamp/-signature
 * headers; verifyWebhook wants a Fetch Request, so we rebuild a minimal one
 * from the raw body Fastify hands us — the body must stay unparsed bytes
 * since the signature covers the exact bytes Clerk sent, same reason the
 * Stripe handler in webhooks.ts registers its own raw-body content parser.
 */
export default async function clerkWebhook(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/api/webhooks/clerk', async (req, reply) => {
    const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
    if (!secret) return reply.code(503).send(fail('webhook_unconfigured', 'CLERK_WEBHOOK_SIGNING_SECRET is not set'));

    const svixId = req.headers['svix-id'];
    if (typeof svixId !== 'string') return reply.code(400).send(fail('invalid_signature', 'missing svix-id header'));

    const svixHeaders: Record<string, string> = {};
    for (const name of ['svix-id', 'svix-timestamp', 'svix-signature']) {
      const value = req.headers[name];
      if (typeof value === 'string') svixHeaders[name] = value;
    }
    const request = new Request('https://clerk.invalid/api/webhooks/clerk', {
      method: 'POST',
      headers: svixHeaders,
      body: new Uint8Array(req.body as Buffer),
    });

    let event: WebhookEvent;
    try {
      event = await verifyWebhook(request, { signingSecret: secret });
    } catch (err) {
      req.log.warn({ err }, 'clerk webhook signature check failed');
      return reply.code(400).send(fail('invalid_signature', 'signature verification failed'));
    }

    if (await alreadyHandled(svixId)) {
      return reply.code(200).send({ received: true, duplicate: true });
    }

    if (event.type === 'user.created') {
      const email = primaryEmail(event.data);
      if (email) {
        await sendWelcomeEmail(email);
      } else {
        req.log.warn({ userId: event.data.id }, 'clerk user.created had no email to welcome');
      }
    }

    await markHandled(svixId);
    return reply.code(200).send({ received: true });
  });
}
