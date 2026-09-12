import { timingSafeEqual } from 'node:crypto';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { QUEUE_NAMES, enqueue, queue, queueConfigured, type QueueName } from './queue.ts';
import type { EmailJob, ShippingJob } from './jobs.ts';

/**
 * The ops surface: a queue dashboard for humans and a JSON API for Postman.
 *
 * Deliberately NOT under /api/*. That prefix is closed to everything but the shop's
 * own page (src/perimeter.ts), which is exactly right for the storefront and exactly
 * wrong for a tool you drive from Postman. So this lives at /admin and is gated by a
 * token instead of by origin — one rule per surface, neither weakening the other.
 */

const fail = (code: string, message: string) => ({ error: { code, message } });

const UI_PATH = '/admin/queues/ui';

// 'paused' is a property of the queue, not a job state — getJobCounts rejects it,
// and isPaused() below reports it instead.
const JOB_STATES = ['active', 'waiting', 'delayed', 'completed', 'failed'] as const;

/** Length-independent compare, so a wrong token cannot be narrowed down by timing. */
function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function presentedToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  // Bearer for Postman and curl; Basic so a browser can be prompted for the dashboard.
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    return decoded.slice(decoded.indexOf(':') + 1);
  }
  return null;
}

export default async function adminRoutes(app: FastifyInstance) {
  // server.ts installs its error handler after this plugin is registered, so this
  // encapsulated context does not inherit it and Fastify's default would leak raw
  // BullMQ messages. Shape them like the rest of the API instead.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.validation) {
      return reply.code(400).send(fail('invalid_request', 'request failed validation'));
    }
    req.log.error({ err }, 'admin route failed');
    return reply.code(500).send(fail('internal_error', 'something broke on our side'));
  });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const expected = process.env.ADMIN_TOKEN;
    if (!expected) {
      return reply.code(503).send(fail('admin_unconfigured', 'the admin surface is not configured'));
    }
    const given = presentedToken(req);
    if (!given || !tokenMatches(given, expected)) {
      // Prompts a browser for the dashboard; Postman just reads the 401.
      reply.header('www-authenticate', 'Basic realm="queues"');
      return reply.code(401).send(fail('unauthorized', 'a valid admin token is required'));
    }

    // The dashboard's asset tags are relative ("static/js/..."), so without a trailing
    // slash the browser resolves them against /admin/queues/ and 404s every one — a
    // page that returns 200 and renders blank. Bull Board already owns this exact
    // route, so the redirect has to happen in a hook rather than as another route.
    if (req.url.split('?')[0] === UI_PATH) return reply.redirect(`${UI_PATH}/`, 301);
  });

  // ---- JSON API (what the Postman collection drives) ----

  app.get('/admin/queues/health', async () => ({
    configured: queueConfigured(),
    queues: QUEUE_NAMES,
  }));

  app.get('/admin/queues/stats', async (_req, reply) => {
    if (!queueConfigured()) return reply.code(503).send(fail('queue_unconfigured', 'REDIS_URL is not set'));
    const stats = await Promise.all(
      QUEUE_NAMES.map(async (name) => {
        const q = queue(name)!;
        const counts = await q.getJobCounts(...JOB_STATES);
        return { queue: name, paused: await q.isPaused(), counts };
      }),
    );
    return { queues: stats };
  });

  app.get<{ Params: { name: string }; Querystring: { state?: string; limit?: number } }>(
    '/admin/queues/:name/jobs',
    {
      schema: {
        params: { type: 'object', required: ['name'], properties: { name: { type: 'string', enum: [...QUEUE_NAMES] } } },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            state: { type: 'string', enum: [...JOB_STATES] },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!queueConfigured()) return reply.code(503).send(fail('queue_unconfigured', 'REDIS_URL is not set'));
      const q = queue(req.params.name as QueueName)!;
      const state = req.query.state ?? 'waiting';
      const limit = req.query.limit ?? 20;
      const jobs = await q.getJobs([state as 'waiting'], 0, limit - 1);
      return {
        queue: req.params.name,
        state,
        jobs: jobs.filter(Boolean).map((job) => ({
          id: job.id,
          name: job.name,
          data: job.data,
          attemptsMade: job.attemptsMade,
          failedReason: job.failedReason ?? null,
          timestamp: job.timestamp,
          processedOn: job.processedOn ?? null,
          finishedOn: job.finishedOn ?? null,
        })),
      };
    },
  );

  // ---- The app's operations, one endpoint each ----
  //
  // These replaced a generic {jobName, data} passthrough. That accepted any shape at
  // all and only failed later, inside the worker, where the caller never saw it — so
  // a typo in a job payload looked like a successful enqueue. Each operation the app
  // actually performs is now its own validated endpoint, and the queue it lands on is
  // a property of the operation rather than something the caller picks.

  const SESSION_ID = { type: 'string', pattern: '^cs_[A-Za-z0-9_]{10,200}$' } as const;
  const EMAIL = { type: 'string', format: 'email', maxLength: 200 } as const;
  const DELAY = { type: 'integer', minimum: 0, maximum: 86_400_000 } as const;

  const body = (properties: Record<string, unknown>, required: string[]) => ({
    type: 'object',
    additionalProperties: false,
    required,
    properties: { ...properties, delayMs: DELAY },
  });

  /** One place that turns a validated request into a queued job, so the four agree. */
  async function submit(
    reply: FastifyReply,
    name: QueueName,
    job: EmailJob | ShippingJob,
    delayMs?: number,
  ) {
    if (!queueConfigured()) return reply.code(503).send(fail('queue_unconfigured', 'REDIS_URL is not set'));
    const jobId = await enqueue(name, job.kind, job, delayMs ? { delay: delayMs } : {});
    return reply.code(202).send({ queue: name, jobId, job: job.kind, status: `/admin/jobs/${name}/${jobId}` });
  }

  app.post<{ Body: { sessionId: string; delayMs?: number } }>(
    '/admin/jobs/payment-confirmation',
    { schema: { body: body({ sessionId: SESSION_ID }, ['sessionId']) } },
    async (req, reply) =>
      submit(reply, 'email', { kind: 'payment-confirmation', sessionId: req.body.sessionId }, req.body.delayMs),
  );

  app.post<{ Body: { to: string; delayMs?: number } }>(
    '/admin/jobs/welcome',
    { schema: { body: body({ to: EMAIL }, ['to']) } },
    async (req, reply) => submit(reply, 'email', { kind: 'welcome', to: req.body.to }, req.body.delayMs),
  );

  app.post<{ Body: { sessionId: string; to: string; trackingNumber?: string; status: string; delayMs?: number } }>(
    '/admin/jobs/shipping-status',
    {
      schema: {
        body: body(
          {
            sessionId: SESSION_ID,
            to: EMAIL,
            trackingNumber: { type: 'string', maxLength: 100 },
            // Exactly the statuses src/email.ts has a template for. Anything else
            // is silently ignored by the worker, so reject it at the door instead.
            status: { type: 'string', enum: ['in_transit', 'delivered', 'failed', 'returned'] },
          },
          ['sessionId', 'to', 'status'],
        ),
      },
    },
    async (req, reply) =>
      submit(reply, 'email', {
        kind: 'shipping-status',
        sessionId: req.body.sessionId,
        to: req.body.to,
        trackingNumber: req.body.trackingNumber ?? null,
        status: req.body.status,
      }, req.body.delayMs),
  );

  app.post<{ Body: { sessionId: string; delayMs?: number } }>(
    '/admin/jobs/purchase-label',
    { schema: { body: body({ sessionId: SESSION_ID }, ['sessionId']) } },
    async (req, reply) =>
      submit(reply, 'shipping', { kind: 'purchase-label', sessionId: req.body.sessionId }, req.body.delayMs),
  );

  /** Follow one job by the id the endpoints above hand back. */
  app.get<{ Params: { queue: string; id: string } }>(
    '/admin/jobs/:queue/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['queue', 'id'],
          properties: { queue: { type: 'string', enum: [...QUEUE_NAMES] }, id: { type: 'string', maxLength: 64 } },
        },
      },
    },
    async (req, reply) => {
      if (!queueConfigured()) return reply.code(503).send(fail('queue_unconfigured', 'REDIS_URL is not set'));
      const job = await queue(req.params.queue as QueueName)!.getJob(req.params.id);
      if (!job) return reply.code(404).send(fail('job_not_found', 'no job with that id'));
      return {
        queue: req.params.queue,
        id: job.id,
        job: job.name,
        state: await job.getState(),
        data: job.data,
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason ?? null,
        processedOn: job.processedOn ?? null,
        finishedOn: job.finishedOn ?? null,
      };
    },
  );

  app.post<{ Params: { name: string; id: string } }>(
    '/admin/queues/:name/jobs/:id/retry',
    {
      schema: {
        params: {
          type: 'object',
          required: ['name', 'id'],
          properties: { name: { type: 'string', enum: [...QUEUE_NAMES] }, id: { type: 'string', maxLength: 64 } },
        },
      },
    },
    async (req, reply) => {
      if (!queueConfigured()) return reply.code(503).send(fail('queue_unconfigured', 'REDIS_URL is not set'));
      const job = await queue(req.params.name as QueueName)!.getJob(req.params.id);
      if (!job) return reply.code(404).send(fail('job_not_found', 'no job with that id'));

      // BullMQ only reprocesses a job that has actually finished. Asking it to retry
      // one that is waiting, delayed or mid-flight throws, so say what is wrong
      // rather than turning a normal race into a 500.
      const state = await job.getState();
      if (state !== 'failed' && state !== 'completed') {
        return reply
          .code(409)
          .send(fail('job_not_retryable', `job is ${state}; only a failed or completed job can be retried`));
      }
      await job.retry(state === 'completed' ? 'completed' : 'failed');
      return { queue: req.params.name, jobId: job.id, retried: true, wasState: state };
    },
  );

  app.delete<{ Params: { name: string; id: string } }>(
    '/admin/queues/:name/jobs/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['name', 'id'],
          properties: { name: { type: 'string', enum: [...QUEUE_NAMES] }, id: { type: 'string', maxLength: 64 } },
        },
      },
    },
    async (req, reply) => {
      if (!queueConfigured()) return reply.code(503).send(fail('queue_unconfigured', 'REDIS_URL is not set'));
      const job = await queue(req.params.name as QueueName)!.getJob(req.params.id);
      if (!job) return reply.code(404).send(fail('job_not_found', 'no job with that id'));
      try {
        await job.remove();
      } catch {
        // A job the worker is holding a lock on cannot be removed mid-flight.
        return reply.code(409).send(fail('job_locked', 'job is being processed right now; try again once it settles'));
      }
      return { queue: req.params.name, jobId: req.params.id, removed: true };
    },
  );

  // ---- The dashboard ----

  if (queueConfigured()) {
    const serverAdapter = new FastifyAdapter();
    createBullBoard({
      queues: QUEUE_NAMES.map((name) => new BullMQAdapter(queue(name)!)),
      serverAdapter,
    });
    serverAdapter.setBasePath(UI_PATH);
    await app.register(serverAdapter.registerPlugin(), { prefix: UI_PATH });
  }
}
