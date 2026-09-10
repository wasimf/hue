import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppInstance } from '../core/http.js';
import { z } from 'zod';
import type { AppContainer } from '../container.js';
import { AppError } from '../core/errors.js';
import type { InvoiceBatch } from '../core/types.js';
import { collectUploads } from '../modules/upload/multipart.js';

const querySchema = z.object({
  debug: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((value) => value === 'true' || value === '1'),
});

const paramsSchema = z.object({ batchId: z.string().min(1) });

function respondWithBatch(batch: InvoiceBatch): Record<string, unknown> {
  return {
    batchId: batch.id,
    createdAt: batch.createdAt,
    completedAt: batch.completedAt,
    summary: batch.summary,
    invoices: batch.invoices,
    rejected: batch.rejected,
    exports: {
      json: `/api/export/${batch.id}?format=json`,
      csv: `/api/export/${batch.id}?format=csv`,
    },
  };
}

/**
 * Upload and retrieval endpoints.
 *
 * `POST /api/invoices` (alias `POST /upload`) accepts one or more files in a
 * single multipart request and returns the extracted data synchronously. For
 * very large batches this handler is the natural place to enqueue jobs instead
 * (see README, "Extending the application").
 */
export async function registerInvoiceRoutes(app: AppInstance, container: AppContainer): Promise<void> {
  const handleUpload = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const { debug } = querySchema.parse(request.query ?? {});
    const uploads = await collectUploads(request, container.config, container.uploads);

    try {
      const batch = await container.pipeline.processBatch(
        uploads.map((upload) => ({ fileName: upload.fileName, buffer: upload.buffer })),
        { debug },
      );
      await container.batches.save(batch);
      return reply.code(201).send(respondWithBatch(batch));
    } finally {
      await container.uploads.cleanup(uploads);
    }
  };

  app.post('/api/invoices', handleUpload);
  app.post('/upload', handleUpload);

  app.get('/api/invoices/:batchId', async (request, reply) => {
    const { batchId } = paramsSchema.parse(request.params);
    const batch = await container.batches.get(batchId);
    if (!batch) throw new AppError('NOT_FOUND', `Batch "${batchId}" was not found or has expired`);
    return reply.send(respondWithBatch(batch));
  });

  app.get('/api/batches', async (request, reply) => {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse((request.query as Record<string, unknown>)?.limit);
    return reply.send({ batches: await container.batches.list(limit) });
  });
}
