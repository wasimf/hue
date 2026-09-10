import type { RawPage } from '../../core/types.js';

export interface OcrRequest {
  /** A single page: an image, or a one-page PDF. */
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  pageNumber: number;
  languages: string[];
}

export interface OcrHealth {
  available: boolean;
  engine?: string;
  details?: Record<string, unknown>;
}

/**
 * The seam between the Node application and whatever performs OCR.
 *
 * Implementations must be stateless and safe to call concurrently. Adding a new
 * engine (a hosted OCR API, a different local model) means implementing this
 * interface and registering it in `createOcrProvider`.
 */
export interface OcrProvider {
  readonly name: string;
  recognize(request: OcrRequest): Promise<RawPage>;
  healthCheck(): Promise<OcrHealth>;
}
