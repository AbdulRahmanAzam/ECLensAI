import { z } from 'zod';
import 'dotenv/config';

/**
 * Vercel sets VERCEL=1 in every build and every function invocation. The only
 * writable path there is /tmp, and an invocation is frozen the moment it
 * responds — so both the upload directory and the job driver need a different
 * default under it than they do on a long-lived server.
 */
const isServerless = process.env.VERCEL === '1';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  /**
   * PostgreSQL connection string. No default: the datasource provider is
   * `postgresql`, so a silently-defaulted SQLite path would only fail later,
   * deep inside the first query, instead of at startup.
   */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (postgresql://...)'),
  JWT_SECRET: z.string().min(16).default('dev-insecure-secret-change-me'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // --- Step 2: ingestion and background jobs -------------------------------
  /**
   * Where uploaded portfolio files are kept. Relative paths resolve from
   * apps/api. On a serverless deployment the bundle is read-only, so the
   * default moves to /tmp — the file only has to outlive the request, and
   * under the `inline` driver the job that reads it runs in that same request.
   */
  UPLOAD_DIR: z.string().default(isServerless ? '/tmp/eclens-uploads' : 'uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  /**
   * Hard bound on parsed rows so a hostile or accidental file cannot exhaust
   * memory. Rows beyond this are dropped and the batch is flagged `truncated`.
   */
  MAX_IMPORT_ROWS: z.coerce.number().int().positive().default(20_000),
  /**
   * `sync` runs jobs inside the API process on a later tick and needs no broker
   * — the documented development fallback so the demo is never blocked by
   * Redis. `inline` runs them in-process too but awaits them before answering,
   * which is the only in-process form that survives a serverless freeze.
   * `bullmq` requires REDIS_URL.
   */
  JOB_QUEUE_DRIVER: z.enum(['sync', 'inline', 'bullmq']).default(isServerless ? 'inline' : 'sync'),
  REDIS_URL: z.string().optional(),

  // --- Step 3: Gemini AI copilot ------------------------------------------
  /**
   * Optional by design. When absent every AI endpoint returns an honest
   * `AI_UNAVAILABLE` state and the rest of the product is unaffected. This
   * value lives only in the server process: it is never echoed in a response,
   * a log line, or a Vite variable.
   */
  GEMINI_API_KEY: z.string().optional(),
  /** Gates `POST /api/v1/demo/reset` — a whole-database wipe-and-reseed, never wired for a real deployment. */
  DEMO_MODE: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),
  AI_ENABLED: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),
  GEMINI_EMBEDDING_MODEL: z.string().default('gemini-embedding-2'),
  /**
   * `bm25` scores chunks in application code over a SQL-prefiltered candidate
   * set and needs no database extension — the offline default. `embedding`
   * stores Gemini vectors on the chunk and ranks by cosine similarity.
   */
  GEMINI_RETRIEVAL_PROVIDER: z.enum(['bm25', 'embedding']).default('bm25'),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** Cap on the tool-evidence loop so a chatty model cannot spin forever. */
  AI_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(8).default(4),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(2_048),
  /** Characters of user question accepted before the request is rejected. */
  AI_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(8_000),
  /** Evidence handed to the synthesis call, in characters. */
  AI_MAX_EVIDENCE_CHARS: z.coerce.number().int().positive().default(24_000),
  AI_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 1000),
  AI_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  /** Rough per-1k-token price in micro-USD, used only for telemetry. */
  AI_COST_MICRO_PER_1K_INPUT: z.coerce.number().int().min(0).default(75),
  AI_COST_MICRO_PER_1K_OUTPUT: z.coerce.number().int().min(0).default(300),
  /**
   * `redact` replaces borrower names with pseudonyms before they leave the
   * process; `pseudonymize` keeps a stable per-request alias; `none` is only
   * appropriate for a deployment whose data is already de-identified.
   */
  AI_REDACTION_PROFILE: z.enum(['redact', 'pseudonymize', 'none']).default('redact'),
  DOCUMENT_AI_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  DOCUMENT_AI_CHUNK_CHARS: z.coerce.number().int().min(200).max(8_000).default(1_800),
});

export const env = envSchema.parse(process.env);

if (env.NODE_ENV === 'production' && env.JWT_SECRET === 'dev-insecure-secret-change-me') {
  throw new Error('JWT_SECRET must be overridden in production');
}

/**
 * BullMQ is used only when it is both requested and reachable. The fallback is
 * `inline` on serverless, where a deferred job would never run, and `sync`
 * everywhere else.
 */
export const resolvedJobQueueDriver: 'sync' | 'inline' | 'bullmq' =
  env.JOB_QUEUE_DRIVER === 'bullmq' && env.REDIS_URL
    ? 'bullmq'
    : env.JOB_QUEUE_DRIVER === 'inline' || (env.JOB_QUEUE_DRIVER === 'bullmq' && isServerless)
      ? 'inline'
      : 'sync';

export type Env = typeof env;
