/**
 * Background job abstraction for import validation/commit and ECL run execution.
 *
 * Two drivers sit behind one interface:
 *
 *   `sync`   — the handler runs inside the API process. No broker, no Redis.
 *              This is the documented development fallback, and it is the
 *              default, so the demo is never blocked by Redis being absent.
 *   `inline` — the same in-process handler, but awaited before `enqueue`
 *              resolves. Required on serverless platforms (Vercel), where the
 *              execution context is frozen the moment the response is sent, so
 *              a job started on a later tick would simply never finish.
 *   `bullmq` — a durable queue plus worker over Redis. Selected only when
 *              JOB_QUEUE_DRIVER=bullmq AND REDIS_URL is set.
 *
 * Under `sync` and `bullmq` `enqueue` returns before the work completes. The
 * HTTP request answers immediately with the entity in a transitional state
 * (VALIDATING / RUNNING) and the client polls for the outcome. That keeps a
 * full portfolio run — hundreds of exposures x scenarios x periods, tens of
 * thousands of persisted period rows — off the request path without requiring
 * an external broker to demonstrate it. Under `inline` the client polls the
 * same way; it just finds the terminal state already written on its first poll.
 *
 * Handlers are responsible for their own terminal state: each one writes
 * COMPLETED/FAILED (or IMPORTED/FAILED) to the database inside a try/catch, so
 * a job that throws still leaves an accurate, auditable status behind.
 */
import { Queue, Worker, type ConnectionOptions, type RedisOptions } from 'bullmq';
import { env, resolvedJobQueueDriver } from '../config/env';
import { logger } from '../lib/logger';

export const JOB_NAMES = ['import.validate', 'import.commit', 'run.execute'] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** Payload contract per job. Adding a job means adding its payload type here. */
export interface JobPayloadMap {
  'import.validate': { batchId: string };
  'import.commit': {
    batchId: string;
    actorId: string | null;
    actorName: string;
    /** False writes duplicates rather than dropping them; the analyst chose this at commit time. */
    skipDuplicates: boolean;
  };
  'run.execute': { runId: string; actorId: string | null; actorName: string };
}

export type JobHandler<K extends JobName> = (payload: JobPayloadMap[K]) => Promise<void>;

export interface EnqueueReceipt {
  jobId: string;
  driver: JobRunner['driver'];
  /** True when the work was started in-process rather than handed to a broker. */
  inProcess: boolean;
}

export interface JobRunner {
  readonly driver: 'sync' | 'inline' | 'bullmq';
  register<K extends JobName>(name: K, handler: JobHandler<K>): void;
  enqueue<K extends JobName>(name: K, payload: JobPayloadMap[K]): Promise<EnqueueReceipt>;
  shutdown(): Promise<void>;
}

/**
 * In-process driver. Work shares the API's memory and event loop — which is
 * exactly why it is a fallback and not the production recommendation.
 *
 * `awaitInline` decides *when* the work runs relative to the HTTP response:
 * false starts it on a later tick and answers immediately, which is what a
 * long-lived Node server wants; true awaits it so the response is only sent
 * once the job is done. A serverless invocation is frozen as soon as it
 * responds, so the deferred form would leave every import stuck in VALIDATING
 * there — hence an option on this class rather than a second copy of it.
 */
class SyncJobRunner implements JobRunner {
  readonly driver: 'sync' | 'inline';
  private readonly handlers = new Map<string, JobHandler<JobName>>();
  private readonly awaitInline: boolean;
  private sequence = 0;

  constructor(awaitInline: boolean) {
    this.awaitInline = awaitInline;
    this.driver = awaitInline ? 'inline' : 'sync';
  }

  register<K extends JobName>(name: K, handler: JobHandler<K>): void {
    this.handlers.set(name, handler as JobHandler<JobName>);
  }

  async enqueue<K extends JobName>(name: K, payload: JobPayloadMap[K]): Promise<EnqueueReceipt> {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new Error(`No handler registered for job "${name}"`);
    }
    this.sequence += 1;
    const jobId = `${this.driver}-${name}-${this.sequence}`;

    const run = async (): Promise<void> => {
      const startedAt = Date.now();
      try {
        await handler(payload);
        logger.debug({ jobId, job: name, durationMs: Date.now() - startedAt }, 'job finished');
      } catch (error) {
        // The handler persists its own FAILED state; this is the safety net
        // for anything it did not catch, so the process never dies on a job.
        logger.error({ jobId, job: name, err: error }, 'unhandled job failure');
      }
    };

    if (this.awaitInline) {
      await run();
    } else {
      setImmediate(() => void run());
    }

    return { jobId, driver: this.driver, inProcess: true };
  }

  async shutdown(): Promise<void> {
    this.handlers.clear();
  }
}

/**
 * BullMQ takes connection *options*, not a URL. `maxRetriesPerRequest` has to be
 * null on a blocking connection or the worker rejects every job it picks up.
 */
function toRedisOptions(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl);
  const options: RedisOptions = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    maxRetriesPerRequest: null,
  };
  if (url.username) options.username = decodeURIComponent(url.username);
  if (url.password) options.password = decodeURIComponent(url.password);
  const database = url.pathname.replace(/^\//, '');
  if (database) options.db = Number(database);
  if (url.protocol === 'rediss:') options.tls = {};
  return options;
}

/** Durable Redis-backed driver. One queue and one worker per job name. */
class BullMqJobRunner implements JobRunner {
  readonly driver = 'bullmq' as const;
  private readonly connection: ConnectionOptions;
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  private sequence = 0;

  constructor(redisUrl: string) {
    this.connection = toRedisOptions(redisUrl);
  }

  register<K extends JobName>(name: K, handler: JobHandler<K>): void {
    const worker = new Worker(
      name,
      async (job) => {
        await handler(job.data as JobPayloadMap[K]);
      },
      { connection: this.connection },
    );
    worker.on('failed', (job, error) => {
      logger.error({ jobId: job?.id, job: name, err: error }, 'bullmq job failed');
    });
    this.workers.push(worker);
  }

  async enqueue<K extends JobName>(name: K, payload: JobPayloadMap[K]): Promise<EnqueueReceipt> {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection });
      this.queues.set(name, queue);
    }
    this.sequence += 1;
    const job = await queue.add(name, payload, {
      jobId: `${name}-${Date.now()}-${this.sequence}`,
      removeOnComplete: false,
      removeOnFail: false,
      attempts: 1,
    });
    return { jobId: String(job.id), driver: this.driver, inProcess: false };
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.workers.length = 0;
    this.queues.clear();
  }
}

function createRunner(): JobRunner {
  if (resolvedJobQueueDriver === 'bullmq' && env.REDIS_URL) {
    logger.info({ driver: 'bullmq' }, 'job runner: durable Redis-backed queue');
    return new BullMqJobRunner(env.REDIS_URL);
  }
  if (env.JOB_QUEUE_DRIVER === 'bullmq' && !env.REDIS_URL) {
    logger.warn(
      'JOB_QUEUE_DRIVER=bullmq but REDIS_URL is not set — falling back to the in-process driver. Jobs will not survive a restart.',
    );
  }
  if (resolvedJobQueueDriver === 'inline') {
    logger.info(
      { driver: 'inline' },
      'job runner: in-process driver awaited before the response (serverless-safe; the request is held for the length of the job)',
    );
    return new SyncJobRunner(true);
  }
  logger.info(
    { driver: 'sync' },
    'job runner: in-process sync driver (development fallback; set JOB_QUEUE_DRIVER=bullmq and REDIS_URL for a durable queue)',
  );
  return new SyncJobRunner(false);
}

export const jobs: JobRunner = createRunner();
