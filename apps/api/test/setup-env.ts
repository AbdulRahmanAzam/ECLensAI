/**
 * Pins the whole suite to the isolated test database before anything else runs.
 *
 * Vitest evaluates setup files before the test modules, so this executes before
 * `src/config/env.ts` parses `process.env` and before the Prisma Client reads
 * `DATABASE_URL`. `.env.test` is loaded first and `.env` second, and dotenv
 * never overrides a variable that is already set — so the developer's own
 * `DATABASE_URL` cannot win, and the later `import 'dotenv/config'` inside
 * `src/config/env.ts` cannot undo this either.
 *
 * The guard at the bottom is the point of the file: without it, deleting
 * `.env.test` would silently turn every integration test into a write against
 * the demo book, and the audit log — append-only, with no delete route — would
 * keep the residue forever.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));

const testEnvFile = `${apiRoot}/.env.test`;
if (existsSync(testEnvFile)) {
  loadDotenv({ path: testEnvFile });
}

// Everything the tests do not need to isolate — JWT secret, upload directory,
// job driver — still comes from the developer's own .env.
const devEnvFile = `${apiRoot}/.env`;
if (existsSync(devEnvFile)) {
  loadDotenv({ path: devEnvFile });
}

process.env.NODE_ENV = 'test';

// SQLite: DATABASE_URL is a `file:` path (e.g. `file:./test.db`), not a server
// URL — there is no hostname/pathname to parse the way a postgresql:// URL has.
// The safety check instead looks at the file's own name.
const databaseUrl = process.env.DATABASE_URL ?? '';
const databaseName = databaseUrl.startsWith('file:')
  ? databaseUrl.slice('file:'.length).replace(/^\.?\/*/, '')
  : '';

if (!databaseName.includes('test')) {
  throw new Error(
    `[api tests] refusing to run against database '${databaseName || 'unknown'}'. ` +
      'The suite needs an isolated database because audit events are append-only and a test ' +
      'run would permanently pollute the demo book. Restore apps/api/.env.test so DATABASE_URL ' +
      'points at a SQLite file with "test" in its name, then run `npm run db:test:prepare`.',
  );
}
