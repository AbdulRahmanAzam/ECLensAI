/**
 * Binds job names to their service handlers.
 *
 * Kept apart from `jobs/index.ts` so the runner stays free of service imports:
 * the services import the runner to enqueue work, and a runner that imported
 * them back would be a cycle. Registration is idempotent because `createApp` is
 * called once per process in production but once per suite in tests, and the
 * BullMQ driver would otherwise start a second worker per call.
 */
import { jobs } from './index';
import { runImportCommit, validateImportBatch } from '../services/imports.service';
import { executeRun } from '../services/runs.service';

let registered = false;

export function registerJobHandlers(): void {
  if (registered) return;
  registered = true;

  jobs.register('import.validate', ({ batchId }) => validateImportBatch(batchId));
  jobs.register('import.commit', ({ batchId, actorId, actorName, skipDuplicates }) =>
    runImportCommit(batchId, actorId, actorName, skipDuplicates),
  );
  jobs.register('run.execute', ({ runId, actorId, actorName }) => executeRun(runId, actorId, actorName));
}
