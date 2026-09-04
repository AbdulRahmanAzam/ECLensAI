import { createApp } from './app';
import { env } from './config/env';
import { jobs } from './jobs';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`eclens-api listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

let shuttingDown = false;

const shutdown = async (signal: string): Promise<void> => {
  // A second Ctrl-C would otherwise call server.close on a closed server and
  // reject the shutdown before the database is disconnected.
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Workers stop before the database goes away, so a calculation in flight is
  // never writing through a disconnected client.
  await jobs.shutdown().catch((error: unknown) => logger.error({ err: error }, 'job runner shutdown failed'));
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
