import type { Logger } from 'pino';
import type { AppConfig } from '../../config/index.js';
import { AppError, toAppError } from '../../core/errors.js';
import type { DocumentPage, OcrDocument, RawPage, SupportedMimeType } from '../../core/types.js';
import { mapWithConcurrency } from '../../utils/async.js';
import { detectMimeType } from '../documents/fileTypes.js';
import { buildDocumentPage } from '../documents/pageBuilder.js';
import { getPdfPageCount, splitPdfPages } from '../documents/pdf.js';
import { extractPdfTextLayer, type PdfTextLayerPage } from '../documents/pdfTextLayer.js';
import type { OcrProvider } from '../ocr/provider.js';

export interface DocumentInput {
  fileName: string;
  buffer: Buffer;
}

/**
 * Turns an uploaded file into a normalised, page-aware text document.
 *
 * Responsibilities: page enumeration, choosing the cheapest usable text source
 * per page, bounded-concurrency OCR, and per-page error isolation so that one
 * unreadable page never loses the rest of the document.
 */
export class DocumentProcessor {
  constructor(
    private readonly config: AppConfig,
    private readonly ocr: OcrProvider,
    private readonly logger: Logger,
  ) {}

  async process(input: DocumentInput): Promise<OcrDocument> {
    const startedAt = Date.now();
    const mimeType = await detectMimeType(input.buffer, input.fileName);
    const warnings: string[] = [];

    const pages =
      mimeType === 'application/pdf'
        ? await this.processPdf(input, warnings)
        : await this.processImage(input, mimeType, warnings);

    if (pages.length === 0) {
      throw new AppError('OCR_FAILED', `No page of "${input.fileName}" could be read`);
    }

    const allLines = pages.flatMap((page) => page.lines);
    const meanConfidence =
      allLines.length > 0 ? allLines.reduce((sum, line) => sum + line.confidence, 0) / allLines.length : 0;

    const engines = [...new Set(pages.map((page) => page.source))];

    return {
      fileName: input.fileName,
      mimeType,
      pageCount: pages.length,
      pages,
      engine: engines.join('+'),
      languages: this.config.OCR_LANGS,
      durationMs: Date.now() - startedAt,
      meanConfidence: Math.round(meanConfidence * 1000) / 1000,
      warnings: [...warnings, ...pages.flatMap((page) => page.warnings)],
    };
  }

  private async processImage(
    input: DocumentInput,
    mimeType: SupportedMimeType,
    warnings: string[],
  ): Promise<DocumentPage[]> {
    const raw = await this.ocr.recognize({
      buffer: input.buffer,
      fileName: input.fileName,
      mimeType,
      pageNumber: 1,
      languages: this.config.OCR_LANGS,
    });
    const page = buildDocumentPage(raw, 1, this.ocrSource(), {
      minConfidence: this.config.OCR_MIN_LINE_CONFIDENCE,
    });
    if (page.lines.length === 0) warnings.push('OCR returned no text for this image');
    return [page];
  }

  private async processPdf(input: DocumentInput, warnings: string[]): Promise<DocumentPage[]> {
    const totalPages = await getPdfPageCount(input.buffer);
    if (totalPages === 0) {
      throw new AppError('DOCUMENT_LOAD_FAILED', `"${input.fileName}" contains no pages`);
    }

    const limit = Math.min(totalPages, this.config.MAX_PAGES_PER_DOCUMENT);
    if (limit < totalPages) {
      warnings.push(`Only the first ${limit} of ${totalPages} pages were processed (MAX_PAGES_PER_DOCUMENT)`);
    }
    const pageNumbers = Array.from({ length: limit }, (_, index) => index + 1);

    const textLayer = await this.readTextLayer(input, limit, warnings);
    const pages = new Map<number, DocumentPage>();

    for (const entry of textLayer) {
      if (entry.characterCount < this.config.PDF_TEXT_LAYER_MIN_CHARS) continue;
      pages.set(
        entry.pageNumber,
        buildDocumentPage(entry.page, entry.pageNumber, 'pdf-text-layer', { minConfidence: 0 }),
      );
    }

    const needsOcr = pageNumbers.filter((pageNumber) => !pages.has(pageNumber));
    if (needsOcr.length > 0) {
      const slices = await splitPdfPages(input.buffer, needsOcr);
      const results = await mapWithConcurrency(slices, this.config.OCR_CONCURRENCY, async (slice) => {
        try {
          const raw = await this.ocr.recognize({
            buffer: slice.bytes,
            fileName: `${input.fileName}#page-${slice.pageNumber}`,
            mimeType: 'application/pdf',
            pageNumber: slice.pageNumber,
            languages: this.config.OCR_LANGS,
          });
          return { pageNumber: slice.pageNumber, raw, error: null as AppError | null };
        } catch (error) {
          const appError = toAppError(error, 'OCR_FAILED');
          this.logger.warn(
            { err: appError, fileName: input.fileName, page: slice.pageNumber },
            'OCR failed for a single page',
          );
          return { pageNumber: slice.pageNumber, raw: null as RawPage | null, error: appError };
        }
      });

      if (results.length > 0 && results.every((result) => result.error)) {
        // Every OCR attempt failed: surface the real reason rather than
        // returning an empty "successful" parse.
        const unavailable = results.find((result) => result.error?.code === 'OCR_UNAVAILABLE')?.error;
        if (unavailable) throw unavailable;
        if (pages.size === 0) throw results[0]?.error as AppError;
      }

      for (const result of results) {
        if (result.raw) {
          pages.set(
            result.pageNumber,
            buildDocumentPage(result.raw, result.pageNumber, this.ocrSource(), {
              minConfidence: this.config.OCR_MIN_LINE_CONFIDENCE,
            }),
          );
        } else if (result.error) {
          warnings.push(`Page ${result.pageNumber} could not be OCR'd: ${result.error.message}`);
        }
      }
    }

    return pageNumbers
      .map((pageNumber) => pages.get(pageNumber))
      .filter((page): page is DocumentPage => page !== undefined);
  }

  private async readTextLayer(input: DocumentInput, limit: number, warnings: string[]): Promise<PdfTextLayerPage[]> {
    if (!this.config.PDF_TEXT_LAYER_ENABLED) return [];
    try {
      return await extractPdfTextLayer(input.buffer, limit);
    } catch (error) {
      warnings.push(`The PDF text layer could not be read (${(error as Error).message}); falling back to OCR`);
      this.logger.debug({ err: error, fileName: input.fileName }, 'text layer extraction failed');
      return [];
    }
  }

  private ocrSource(): 'paddleocr' | 'mock' {
    return this.ocr.name === 'mock' ? 'mock' : 'paddleocr';
  }
}
