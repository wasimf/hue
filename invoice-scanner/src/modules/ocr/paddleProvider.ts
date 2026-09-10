import { z } from 'zod';
import type { AppConfig } from '../../config/index.js';
import { AppError } from '../../core/errors.js';
import type { RawPage } from '../../core/types.js';
import { withRetry } from '../../utils/async.js';
import type { OcrHealth, OcrProvider, OcrRequest } from './provider.js';

const boxSchema = z.object({
  x0: z.number(),
  y0: z.number(),
  x1: z.number(),
  y1: z.number(),
});

const pageSchema = z.object({
  page_number: z.number().int().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
  lines: z.array(
    z.object({
      text: z.string(),
      confidence: z.number().min(0).max(1),
      box: boxSchema,
    }),
  ),
  warnings: z.array(z.string()).optional(),
});

const responseSchema = z.object({
  engine: z.string(),
  languages: z.array(z.string()).optional(),
  pages: z.array(pageSchema).min(1),
});

const healthSchema = z.object({
  status: z.string(),
  engine: z.string().optional(),
  languages: z.array(z.string()).optional(),
  models_loaded: z.boolean().optional(),
});

/** Errors worth retrying: transport failures and 5xx from the sidecar. */
function isTransient(error: unknown): boolean {
  if (error instanceof AppError) return error.code === 'OCR_UNAVAILABLE';
  return true;
}

/**
 * Talks to the PaddleOCR sidecar (see `ocr-service/`).
 *
 * The contract is intentionally small — one page in, structured lines out — so
 * the service can be scaled, replaced or moved behind a queue without the
 * Node application changing.
 */
export class PaddleOcrProvider implements OcrProvider {
  readonly name = 'paddleocr';
  private readonly baseUrl: string;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.baseUrl = config.OCR_SERVICE_URL.replace(/\/+$/, '');
  }

  async recognize(request: OcrRequest): Promise<RawPage> {
    const payload = await withRetry(() => this.postPage(request), {
      retries: this.config.OCR_MAX_RETRIES,
      baseDelayMs: 600,
      shouldRetry: isTransient,
    });

    const page = payload.pages[0];
    if (!page) {
      throw new AppError('OCR_FAILED', `The OCR service returned no pages for "${request.fileName}"`);
    }

    return {
      width: page.width,
      height: page.height,
      engine: payload.engine,
      lines: page.lines.map((line) => ({ text: line.text, confidence: line.confidence, box: line.box })),
      warnings: page.warnings ?? [],
    };
  }

  private async postPage(request: OcrRequest): Promise<z.infer<typeof responseSchema>> {
    const form = new FormData();
    form.append('file', new Blob([request.buffer], { type: request.mimeType }), request.fileName);
    form.append('languages', request.languages.join(','));
    form.append('dpi', String(this.config.OCR_PDF_DPI));

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/ocr`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(this.config.OCR_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AppError(
        'OCR_UNAVAILABLE',
        `The OCR service at ${this.baseUrl} is unreachable: ${(error as Error).message}`,
        { cause: error, details: { fileName: request.fileName, pageNumber: request.pageNumber } },
      );
    }

    if (response.status >= 500) {
      throw new AppError('OCR_UNAVAILABLE', `The OCR service returned ${response.status}`, {
        details: { body: await safeText(response) },
      });
    }
    if (!response.ok) {
      throw new AppError('OCR_FAILED', `The OCR service rejected page ${request.pageNumber} of "${request.fileName}"`, {
        details: { status: response.status, body: await safeText(response) },
      });
    }

    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new AppError('OCR_FAILED', 'The OCR service returned an unexpected payload', {
        details: { issues: parsed.error.issues.slice(0, 5) },
      });
    }
    return parsed.data;
  }

  async healthCheck(): Promise<OcrHealth> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { available: false, details: { status: response.status } };
      const parsed = healthSchema.safeParse(await response.json());
      if (!parsed.success) return { available: false, details: { reason: 'unexpected health payload' } };
      return {
        available: parsed.data.status === 'ok',
        engine: parsed.data.engine ?? 'paddleocr',
        details: { languages: parsed.data.languages ?? [], modelsLoaded: parsed.data.models_loaded ?? null },
      };
    } catch (error) {
      return { available: false, details: { reason: (error as Error).message } };
    }
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}
