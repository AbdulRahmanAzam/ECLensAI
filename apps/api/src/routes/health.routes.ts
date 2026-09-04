import type { Request, Response } from 'express';

const startedAt = Date.now();

export function health(_req: Request, res: Response): void {
  res.json({
    status: 'ok',
    service: 'eclens-api',
    version: '0.1.0',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
}
