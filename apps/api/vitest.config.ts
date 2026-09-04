import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runs before every test module, and therefore before `src/config/env.ts`
    // parses `process.env` and before the Prisma Client is constructed. Without
    // it the suite uses the developer's own DATABASE_URL and writes straight
    // into the demo book — permanently, because audit events are append-only.
    setupFiles: [fileURLToPath(new URL('./test/setup-env.ts', import.meta.url))],
    // Every database-backed file resolves the same thing — the newest
    // result-bearing run of the newest snapshot — against one shared seeded
    // database, and `integration.test.ts` transiently creates, approves and
    // deletes a run on exactly that snapshot as its four-eyes fixture. That run
    // is never executed, so its `completedAt` is null, and Postgres sorts
    // `ORDER BY completedAt DESC` nulls first: a file resolving the period
    // mid-fixture would get a run holding no results and no totals. Serialized,
    // the fixture is invisible to every other file.
    fileParallelism: false,
  },
});
