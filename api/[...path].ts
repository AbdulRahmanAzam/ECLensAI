/**
 * Vercel serverless entrypoint for the ECLens API.
 *
 * The whole Express app is served from one function. The filename is a
 * catch-all dynamic route, which is what makes `/api/v1/ecl-runs/:id` reach
 * this file with `req.url` still set to the full original path — a plain
 * `api/index.ts` would only match `/api` and would need a rewrite that rewrites
 * the path Express routes on.
 *
 * `createApp()` runs at module scope, not per request: a warm invocation reuses
 * the same Express instance, the same Prisma client and the same connection.
 *
 * There is no `listen` here. Vercel supplies the HTTP server and hands each
 * request to the exported handler; `apps/api/src/server.ts` remains the entry
 * point for running the API as a long-lived process.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../apps/api/src/app';

const app = createApp();

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  app(req, res);
}
