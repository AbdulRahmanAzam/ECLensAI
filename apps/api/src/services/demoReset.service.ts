/**
 * Demo data reset — Guided Demo support (step 4, judge_mode).
 *
 * `prisma/seed.ts` is a 500-line script with its own `PrismaClient`, its own
 * `dotenv/config`, and full ownership of the wipe-then-rebuild sequence; it
 * is also already proven correct (it is how every demo dataset in this repo
 * was produced, run after run, by hand). Reimplementing that logic here to
 * call it in-process would risk drifting from the one seed a judge's demo
 * actually depends on. Instead this shells out to the exact same command
 * `npm run db:seed` runs (`prisma db seed`, which resolves to `tsx
 * prisma/seed.ts` via the `prisma.seed` field in package.json) and reports
 * its exit code — one implementation of "what the demo data is," reused,
 * not duplicated.
 *
 * The reset is a full, unscoped delete-then-reseed (every organisation, not
 * just the caller's) because this deployment seeds exactly one demo
 * organisation. It is never safe to expose outside a demo deployment, which
 * is why the route gates it on `DEMO_MODE` in addition to a role check.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AuditActor } from '../lib/audit';
import { logger } from '../lib/logger';
import { HttpError } from '../utils/httpError';

const execFileAsync = promisify(execFile);

/** Generous: the seed computes three full ECL runs (Decimal.js, thousands of periods). */
const RESET_TIMEOUT_MS = 180_000;

export interface DemoResetResult {
  ok: true;
  durationMs: number;
}

/**
 * The reseed deletes and recreates every row, `AuditEvent` included, with
 * fresh ids — the caller's own organisation and user id stop existing partway
 * through. Recording an audit row keyed to the pre-reset actor after the fact
 * would either dangle (the org is gone) or misleadingly land on a *new*
 * organisation that only coincidentally has the same seeded name. This is
 * logged to the server log instead, which is the honest record of an action
 * that, by definition, invalidates the audit trail it would otherwise land in.
 */
export async function resetDemoData(actor: AuditActor): Promise<DemoResetResult> {
  const startedAt = Date.now();
  logger.info({ actorId: actor.id, actorRole: actor.role }, 'Demo data reset requested');

  try {
    // `npx` resolves to `npx.cmd` on Windows, a batch-file wrapper that
    // `execFile` cannot invoke directly (no shell, so no `.cmd` handling) —
    // `shell: true` is required here, safe because every argument is a fixed
    // literal, never caller-supplied input.
    await execFileAsync('npx', ['prisma', 'db', 'seed'], {
      cwd: process.cwd(),
      timeout: RESET_TIMEOUT_MS,
      env: process.env,
      shell: true,
    });
  } catch (error) {
    logger.error({ err: error }, 'Demo data reset failed');
    throw new HttpError(500, 'DEMO_RESET_FAILED', 'The demo data reset did not complete. The database may be partially reseeded; try again.');
  }

  const durationMs = Date.now() - startedAt;
  logger.info({ durationMs }, 'Demo data reset completed');
  return { ok: true, durationMs };
}
