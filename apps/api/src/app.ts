import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { AuthController, authMiddleware } from './auth.js';
import { BodyController } from './body.js';
import { CatalogController } from './catalog.js';
import { HealthController, MeController } from './me.js';
import { SessionsController } from './sessions.js';
import { JsonErrorFilter, requestId, sendError } from './common.js';

@Module({ controllers: [AuthController, CatalogController, SessionsController, BodyController, MeController, HealthController] })
class AppModule {}

const json = (limit: string) => {
  const parser = express.json({ limit, strict: true });
  return (req: Request, res: Response, next: NextFunction) =>
    parser(req, res, (err?: { type?: string }) => {
      if (!err) return next();
      if (err.type === 'entity.too.large') return sendError(req, res, 413, 'TOO_LARGE', 'Request body too large');
      sendError(req, res, 400, 'BAD_JSON', 'Malformed JSON body');
    });
};

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, logger: ['error', 'warn', 'log'] });
  // Only the host nginx (reached via the docker bridge / loopback) may set X-Forwarded-For.
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'https://i.ytimg.com'],
          frameSrc: ['https://www.youtube-nocookie.com'], connectSrc: ["'self'"], frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
        },
      },
      // YouTube embeds refuse to play without a referrer (error 153), so not `no-referrer`.
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.use(cookieParser());
  app.use('/api/v1/plan-imports', json('3mb'));
  app.use('/api', json('200kb'));
  app.use('/api', authMiddleware);
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new JsonErrorFilter());

  const web = process.env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(web)) {
    const assets = express.static(web, { index: false, setHeaders: (res, path) => res.setHeader('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache') });
    // SPA fallback for non-API GETs only: API 404s stay JSON.
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api/') || req.path === '/api' || !['GET', 'HEAD'].includes(req.method)) return next();
      assets(req, res, () => {
        if (/\.[a-z0-9]+$/i.test(req.path)) return res.status(404).type('text').send('Not found');
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile('index.html', { root: web });
      });
    });
  }
  app.enableShutdownHooks();
  return app;
}
