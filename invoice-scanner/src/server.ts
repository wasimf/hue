import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { createContainer, type AppContainer, type ContainerOverrides } from './container.js';
import type { AppInstance } from './core/http.js';
import { AppError, toAppError } from './core/errors.js';
import { registerExportRoutes } from './routes/export.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerInvoiceRoutes } from './routes/invoices.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
/** `public/` sits next to `src/` in development and next to `dist/` in production. */
const publicDirectory = path.resolve(moduleDirectory, '..', 'public');

export interface Server {
  app: AppInstance;
  container: AppContainer;
}

export async function createServer(overrides: ContainerOverrides = {}): Promise<Server> {
  const container = createContainer(overrides);
  const { config, logger } = container;

  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: config.MAX_FILE_SIZE_BYTES,
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: config.MAX_FILE_SIZE_BYTES,
      files: config.MAX_FILES_PER_BATCH,
    },
  });

  await app.register(fastifyStatic, { root: publicDirectory, prefix: '/', index: ['index.html'] });

  await container.uploads.init();

  await registerHealthRoutes(app, container);
  await registerInvoiceRoutes(app, container);
  await registerExportRoutes(app, container);

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` } });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: 'Invalid request', details: { issues: error.issues.slice(0, 5) } },
      });
      return;
    }

    // Fastify's own multipart guards surface as codes, not AppErrors.
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      reply.code(413).send({
        error: { code: 'FILE_TOO_LARGE', message: `A file exceeds the ${config.MAX_FILE_SIZE_BYTES} byte limit` },
      });
      return;
    }
    if ((error as { code?: string }).code === 'FST_FILES_LIMIT') {
      reply.code(413).send({
        error: { code: 'TOO_MANY_FILES', message: `At most ${config.MAX_FILES_PER_BATCH} files per batch` },
      });
      return;
    }

    const appError = error instanceof AppError ? error : toAppError(error);
    if (appError.statusCode >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.warn({ err: appError.message, code: appError.code }, 'request rejected');
    }
    reply.code(appError.statusCode).send({ error: appError.toJSON() });
  });

  return { app, container };
}
