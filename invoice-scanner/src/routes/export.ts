import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppInstance } from '../core/http.js';
import { z } from 'zod';
import type { AppContainer } from '../container.js';
import { AppError } from '../core/errors.js';
import type { Invoice, InvoiceBatch } from '../core/types.js';
import { exportBatch, type ExportFormat } from '../modules/export/index.js';

const formatSchema = z.enum(['json', 'csv']).default('json');

const invoiceSchema = z.object({
  issuer: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  assignee: z.string().nullable(),
  invoiceSum: z.number().nullable(),
  invoiceVat: z.number().nullable(),
  invoiceSumAndVat: z.number().nullable(),
  sourceFileName: z.string(),
  warnings: z.array(z.string()).default([]),
});

const adHocSchema = z.object({
  format: formatSchema,
  invoices: z.array(invoiceSchema).min(1),
});

/** Wraps a bare invoice array in the batch shape the exporters expect. */
function syntheticBatch(invoices: Invoice[]): InvoiceBatch {
  const now = new Date().toISOString();
  return {
    id: 'adhoc',
    createdAt: now,
    completedAt: now,
    summary: { total: invoices.length, ok: invoices.length, needsReview: 0, failed: 0 },
    rejected: [],
    invoices: invoices.map((invoice) => ({
      id: 'adhoc',
      status: 'ok' as const,
      invoice,
      quality: {
        classification: 'invoice' as const,
        invoiceScore: 1,
        meanOcrConfidence: 1,
        totalCharacters: 0,
        matchedKeywords: [],
        detectedLanguages: [],
      },
      issues: [],
      fieldConfidence: {},
      meta: {
        sourceFileName: invoice.sourceFileName,
        mimeType: 'application/json',
        byteSize: 0,
        pageCount: 0,
        ocrEngine: 'n/a',
        languages: [],
        processingMs: 0,
      },
    })),
  };
}

/**
 * Export endpoints.
 *
 * `GET  /api/export/:batchId?format=json|csv` exports a stored batch.
 * `POST /api/export`                          exports an arbitrary (e.g. user
 *                                             corrected) invoice array.
 */
export async function registerExportRoutes(app: AppInstance, container: AppContainer): Promise<void> {
  const send = (reply: FastifyReply, batch: InvoiceBatch, format: ExportFormat, download: boolean): FastifyReply => {
    const result = exportBatch(batch, format);
    reply.header('content-type', result.contentType);
    if (download) reply.header('content-disposition', `attachment; filename="${result.fileName}"`);
    return reply.send(result.body);
  };

  const exportStored = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const { batchId } = z.object({ batchId: z.string().min(1) }).parse(request.params);
    const query = z
      .object({ format: formatSchema, download: z.enum(['true', 'false']).default('true') })
      .parse(request.query ?? {});

    const batch = await container.batches.get(batchId);
    if (!batch) throw new AppError('NOT_FOUND', `Batch "${batchId}" was not found or has expired`);
    return send(reply, batch, query.format, query.download === 'true');
  };

  app.get('/api/export/:batchId', exportStored);
  app.get('/export/:batchId', exportStored);

  app.post('/api/export', async (request, reply) => {
    const parsed = adHocSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('BAD_REQUEST', 'Invalid export payload', { details: { issues: parsed.error.issues.slice(0, 5) } });
    }
    return send(reply, syntheticBatch(parsed.data.invoices as Invoice[]), parsed.data.format, true);
  });
}
