import { Queue, Worker, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * BullMQ on Render Key Value (Valkey 8).
 *
 * Optional on purpose, the same way SHIPPO_API_KEY is: with no REDIS_URL the shop
 * still takes orders, and the work that would have been queued runs inline instead
 * (see runOrQueue in src/jobs.ts). A missing queue must never cost a sale.
 *
 * ponytail: the worker runs in this same process. Render's free tier has no
 * background-worker service, and a free web service hibernates, so nothing drains
 * the queue while the app is asleep — a delayed or retrying job waits for the next
 * request to wake it. Move the worker to its own service if that lag ever matters.
 */

export const QUEUE_NAMES = ['email', 'shipping'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const queueConfigured = (): boolean => Boolean(process.env.REDIS_URL);

let connection: Redis | null = null;
const queues = new Map<QueueName, Queue>();
const workers: Worker[] = [];

function conn(): ConnectionOptions {
  // maxRetriesPerRequest MUST be null or BullMQ refuses to build a Worker on it.
  connection ??= new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  return connection as unknown as ConnectionOptions;
}

/**
 * Retries with backoff, because every job here talks to a third party that fails
 * for a minute at a time. Completed jobs are kept briefly so the UI has something
 * to show; failures are kept far longer, since those are the ones worth reading.
 */
const DEFAULTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 3600, count: 200 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export function queue(name: QueueName): Queue | null {
  if (!queueConfigured()) return null;
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: conn(), defaultJobOptions: DEFAULTS });
    queues.set(name, q);
  }
  return q;
}

/** Returns the job id, or null when there is no queue to put it on. */
export async function enqueue(
  name: QueueName,
  jobName: string,
  data: unknown,
  opts: JobsOptions = {},
): Promise<string | null> {
  const q = queue(name);
  if (!q) return null;
  const job = await q.add(jobName, data, opts);
  return job.id ?? null;
}

export function startWorkers(
  handlers: Record<QueueName, (jobName: string, data: unknown) => Promise<unknown>>,
  log: { info: (o: unknown, m: string) => void; error: (o: unknown, m: string) => void },
): void {
  if (!queueConfigured()) return;
  for (const name of QUEUE_NAMES) {
    const worker = new Worker(name, async (job) => handlers[name](job.name, job.data), {
      connection: conn(),
      // One at a time: this is a 512MB shared instance, and every job is IO-bound
      // against a third party that rate limits anyway.
      concurrency: 1,
    });
    worker.on('failed', (job, err) => log.error({ err, queue: name, jobId: job?.id }, 'job failed'));
    worker.on('completed', (job) => log.info({ queue: name, jobId: job.id }, 'job completed'));
    workers.push(worker);
  }
}

/** Let in-flight jobs finish on SIGTERM rather than stranding them as stalled. */
export async function closeQueues(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all([...queues.values()].map((q) => q.close()));
  await connection?.quit();
  workers.length = 0;
  queues.clear();
  connection = null;
}
