import type { RoleName } from '@prisma/client';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { requireRole } from '../src/middleware/auth';

// These tests intentionally avoid database access: health, routing,
// validation, error handling and authorization logic are all DB-independent.
const app = createApp();

describe('test harness isolation', () => {
  // test/setup-env.ts refuses to run against a non-test database, but it only
  // executes because vitest.config.ts lists it under `setupFiles`. Drop that
  // entry and nothing throws — the suite would quietly write into the demo book,
  // permanently, because audit events are append-only. Asserting the invariant
  // from inside a test file makes that removal fail loudly.
  it('points the Prisma datasource at an isolated SQLite test file', () => {
    const databaseUrl = process.env.DATABASE_URL ?? '';
    const databaseName = databaseUrl.startsWith('file:') ? databaseUrl.slice('file:'.length).replace(/^\.?\/*/, '') : '';
    expect(databaseName.includes('test'), `DATABASE_URL targets '${databaseName}'`).toBe(true);
    expect(process.env.NODE_ENV).toBe('test');
  });
});

describe('GET /health', () => {
  it('returns ok with a request id header', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.service).toBe('eclens-api');
    expect(response.headers['x-request-id']).toBeTruthy();
  });
});

describe('routing and errors', () => {
  it('returns a JSON 404 envelope for unknown routes', async () => {
    const response = await request(app).get('/api/v1/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects malformed JSON bodies', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{not-json');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });
});

describe('POST /api/v1/auth/login validation', () => {
  it('rejects an invalid email without touching the database', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: 'Demo1234!' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details.length).toBeGreaterThan(0);
  });

  it('rejects a password that is too short', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'demo@eclens.ai', password: 'short' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('requireRole middleware', () => {
  const run = (userRole: RoleName, allowed: RoleName[]): { status: number | null } => {
    let statusCode: number | null = null;
    const res = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(body: unknown) {
        return body;
      },
    };
    const next = vi.fn();
    const req = { user: { role: userRole }, requestId: 'test' };
    // Minimal fakes; only status/json/next are used by the middleware.
    (requireRole(...allowed) as never)(req as never, res as never, next);
    return { status: next.mock.calls.length > 0 ? null : statusCode };
  };

  it('allows a user whose role is permitted', () => {
    expect(run('ADMIN', ['ADMIN', 'REVIEWER'])).toEqual({ status: null });
  });

  it('returns 403 for a role that is not permitted', () => {
    expect(run('AUDITOR', ['ADMIN'])).toEqual({ status: 403 });
  });
});
