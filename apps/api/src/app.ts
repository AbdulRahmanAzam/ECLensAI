import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { registerJobHandlers } from './jobs/register';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestId } from './middleware/requestId';
import { aiRouter } from './routes/ai.routes';
import { analyticsRouter } from './routes/analytics.routes';
import { auditRouter } from './routes/audit.routes';
import { authRouter } from './routes/auth.routes';
import { demoRouter } from './routes/demo.routes';
import { documentsRouter } from './routes/documents.routes';
import { exceptionsRouter } from './routes/exceptions.routes';
import { modelConfigurationsRouter, scenarioSetsRouter } from './routes/governance.routes';
import { health } from './routes/health.routes';
import { importsRouter } from './routes/imports.routes';
import { exposuresRouter, overridesRouter } from './routes/overrides.routes';
import { portfolioRouter } from './routes/portfolio.routes';
import { runsRouter } from './routes/runs.routes';
import { templatesRouter } from './routes/templates.routes';

export function createApp(): Express {
  // Bound before the first request so an upload or an execution can never hit
  // "no handler registered". Idempotent, so a suite that builds the app per test
  // does not start a second BullMQ worker each time.
  registerJobHandlers();

  const app = express();
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestId);
  app.use(pinoHttp({ logger, customLogLevel: (_req, res) => (res.statusCode >= 500 ? 'error' : 'info') }));

  // Rate-limit foundation for all versioned endpoints; stricter limit on auth.
  const apiLimiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' },
    },
  });
  const authLimiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts, please try again later' },
    },
  });

  app.get('/health', health);
  app.use('/api/v1', apiLimiter);
  app.use('/api/v1/auth', authLimiter, authRouter);

  app.use('/api/v1/imports', importsRouter);
  app.use('/api/v1/templates', templatesRouter);
  app.use('/api/v1/portfolio', portfolioRouter);
  app.use('/api/v1/analytics', analyticsRouter);
  app.use('/api/v1/exposures', exposuresRouter);
  app.use('/api/v1/stage-overrides', overridesRouter);
  app.use('/api/v1/scenario-sets', scenarioSetsRouter);
  app.use('/api/v1/model-configurations', modelConfigurationsRouter);
  app.use('/api/v1/ecl-runs', runsRouter);
  app.use('/api/v1/exceptions', exceptionsRouter);
  app.use('/api/v1/audit-events', auditRouter);
  app.use('/api/v1/demo', demoRouter);
  // The AI budget is enforced inside these two routers rather than here: it is
  // keyed by user id, so it has to run after `requireAuth` has resolved the
  // session cookie. Mounting it at this level would key every analyst by IP.
  app.use('/api/v1/ai', aiRouter);
  app.use('/api/v1/documents', documentsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
