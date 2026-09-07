#!/usr/bin/env node
/**
 * Prepares the isolated database the apps/api test suite runs against.
 *
 * `prisma migrate deploy` creates the database when it does not exist yet, then
 * applies every committed migration; `prisma db seed` loads the same
 * deterministic demo book the development database holds, because the
 * integration tests assert on the seeded portfolio rather than building their
 * own fixtures from nothing.
 *
 * DATABASE_URL is read from `.env.test` and exported to the child processes.
 * Prisma and dotenv both leave an already-set variable alone, so neither the
 * CLI nor `prisma/seed.ts`'s own `import 'dotenv/config'` can redirect this
 * back at the development book.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const envTestPath = fileURLToPath(new URL('../.env.test', import.meta.url));

if (!existsSync(envTestPath)) {
  console.error('[prepare-test-db] apps/api/.env.test is missing; cannot tell which database to prepare.');
  process.exit(1);
}

loadDotenv({ path: envTestPath });

// Two URL shapes have to be understood here. A `file:` URL is a SQLite path
// with no hostname to parse; a postgresql:// URL carries the database in its
// pathname. Either way the guard is the same: the name must say 'test', so a
// mistyped .env.test can never point the suite at a real book.
const databaseUrl = process.env.DATABASE_URL ?? '';

function databaseNameOf(url) {
  if (url.startsWith('file:')) return url.slice('file:'.length).replace(/^\.?\/*/, '');
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

const databaseName = databaseNameOf(databaseUrl);

if (!databaseName.includes('test')) {
  console.error(
    `[prepare-test-db] refusing to touch database '${databaseName || 'unknown'}': .env.test must point at a database with 'test' in its name.`,
  );
  process.exit(1);
}

console.log(`[prepare-test-db] target database: ${databaseName}`);

function run(label, args) {
  console.log(`\n[prepare-test-db] ${label}`);
  const result = spawnSync('npx', ['--no-install', ...args], {
    cwd: apiRoot,
    env: process.env,
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    console.error(`[prepare-test-db] ${label} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

run('applying migrations', ['prisma', 'migrate', 'deploy']);
run('seeding', ['prisma', 'db', 'seed']);

console.log(`\n[prepare-test-db] ${databaseName} is ready. Run the suite with: npm test`);
