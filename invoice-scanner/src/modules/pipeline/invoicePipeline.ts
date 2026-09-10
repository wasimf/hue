import type { Logger } from 'pino';
import type { AppConfig } from '../../config/index.js';
import { toAppError } from '../../core/errors.js';
import type {
  BatchSummary,
  FieldCandidate,
  InvoiceBatch,
  InvoiceDebugInfo,
  ProcessedInvoice,
  RejectedFile,
} from '../../core/types.js';
import { mapWithConcurrency } from '../../utils/async.js';
import { newId } from '../../utils/id.js';
import { mapDocumentToInvoice } from '../parsing/fieldMapper.js';
import { applyIssuesToInvoice, validateInvoice } from '../validation/invoiceValidator.js';
import type { DocumentInput, DocumentProcessor } from './documentProcessor.js';

export interface PipelineOptions {
  /** Include per-field candidate lists and page text in the response. */
  debug?: boolean;
  /** Injected for deterministic tests. */
  now?: Date;
}

/**
 * Orchestrates the full per-file journey: OCR -> field mapping -> validation.
 *
 * A failure is always scoped to one file; the rest of the batch continues and
 * the failure is reported in `batch.rejected`.
 */
export class InvoicePipeline {
  constructor(
    private readonly config: AppConfig,
    private readonly processor: DocumentProcessor,
    private readonly logger: Logger,
  ) {}

  async processFile(input: DocumentInput, options: PipelineOptions = {}): Promise<ProcessedInvoice> {
    const startedAt = Date.now();
    const now = options.now ?? new Date();

    const document = await this.processor.process(input);
    const mapped = mapDocumentToInvoice(document, this.config, now);

    const { status, issues } = validateInvoice({
      invoice: mapped.invoice,
      quality: mapped.quality,
      fieldConfidence: mapped.fieldConfidence,
      ambiguousFields: mapped.ambiguousFields,
      vatRate: mapped.vatRate,
      config: this.config,
      now,
    });
    applyIssuesToInvoice(mapped.invoice, issues);

    for (const warning of document.warnings) {
      const message = `[DOCUMENT] ${warning}`;
      if (!mapped.invoice.warnings.includes(message)) mapped.invoice.warnings.push(message);
    }

    const processed: ProcessedInvoice = {
      id: newId('inv'),
      status,
      invoice: mapped.invoice,
      quality: mapped.quality,
      issues,
      fieldConfidence: mapped.fieldConfidence,
      meta: {
        sourceFileName: input.fileName,
        mimeType: document.mimeType,
        byteSize: input.buffer.byteLength,
        pageCount: document.pageCount,
        ocrEngine: document.engine,
        languages: document.languages,
        processingMs: Date.now() - startedAt,
      },
    };

    if (options.debug) {
      processed.debug = buildDebugInfo(mapped, document.pages);
    }

    this.logger.info(
      {
        fileName: input.fileName,
        status,
        pages: document.pageCount,
        engine: document.engine,
        ms: processed.meta.processingMs,
      },
      'invoice processed',
    );

    return processed;
  }

  async processBatch(inputs: DocumentInput[], options: PipelineOptions = {}): Promise<InvoiceBatch> {
    const createdAt = new Date();
    const invoices: ProcessedInvoice[] = [];
    const rejected: RejectedFile[] = [];

    const results = await mapWithConcurrency(inputs, this.config.OCR_CONCURRENCY, async (input) => {
      try {
        return { ok: true as const, value: await this.processFile(input, options) };
      } catch (error) {
        const appError = toAppError(error, 'PARSING_FAILED');
        this.logger.error({ err: appError, fileName: input.fileName }, 'invoice processing failed');
        return {
          ok: false as const,
          value: { sourceFileName: input.fileName, code: appError.code, message: appError.message },
        };
      }
    });

    for (const result of results) {
      if (result.ok) invoices.push(result.value);
      else rejected.push(result.value);
    }

    return {
      id: newId('batch'),
      createdAt: createdAt.toISOString(),
      completedAt: new Date().toISOString(),
      summary: summarise(invoices, rejected),
      invoices,
      rejected,
    };
  }
}

function summarise(invoices: ProcessedInvoice[], rejected: RejectedFile[]): BatchSummary {
  return {
    total: invoices.length + rejected.length,
    ok: invoices.filter((invoice) => invoice.status === 'ok').length,
    needsReview: invoices.filter((invoice) => invoice.status === 'needs_review').length,
    failed: invoices.filter((invoice) => invoice.status === 'failed').length + rejected.length,
  };
}

function buildDebugInfo(
  mapped: ReturnType<typeof mapDocumentToInvoice>,
  pages: Awaited<ReturnType<DocumentProcessor['process']>>['pages'],
): InvoiceDebugInfo {
  const candidates: Record<string, FieldCandidate[]> = {};
  for (const [field, extraction] of Object.entries(mapped.extractions)) {
    candidates[field] = [
      ...(extraction.selected ? [extraction.selected as FieldCandidate] : []),
      ...(extraction.alternatives as FieldCandidate[]),
    ];
  }

  return {
    candidates,
    pages: pages.map((page) => ({
      pageNumber: page.pageNumber,
      source: page.source,
      meanConfidence: page.meanConfidence,
      lineCount: page.lines.length,
      text: page.lines.map((line) => line.text).join('\n'),
    })),
  };
}
