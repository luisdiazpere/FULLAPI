import { timingSafeEqual } from 'node:crypto';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { QUEUE_NAMES, enqueue, queue, queueConfigured, type QueueName } from './queue.ts';

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

  app.post<{ Params: { name: string }; Body: { jobName: string; data?: unknown; delayMs?: number } }>(
    '/admin/queues/:name/jobs',
    {
      schema: {
        params: { type: 'object', required: ['name'], properties: { name: { type: 'string', enum: [...QUEUE_NAMES] } } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['jobName'],
          properties: {
            jobName: { type: 'string', minLength: 1, maxLength: 64 },
            data: {},
            delayMs: { type: 'integer', minimum: 0, maximum: 86_400_000 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!queueConfigured()) return reply.code(503).send(fail('queue_unconfigured', 'REDIS_URL is not set'));
      const jobId = await enqueue(
        req.params.name as QueueName,
        req.body.jobName,
        req.body.data ?? {},
        req.body.delayMs ? { delay: req.body.delayMs } : {},
      );
      return reply.code(201).send({ queue: req.params.name, jobId });
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
