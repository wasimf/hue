import { AppError } from '../../core/errors.js';
import type { RawPage } from '../../core/types.js';
import type { OcrHealth, OcrProvider, OcrRequest } from './provider.js';

/**
 * Used where no OCR engine can run — a serverless deployment, for example.
 *
 * PDFs that carry a text layer are still parsed exactly; anything that needs
 * pixels fails immediately with an explanation instead of a connection error
 * against a service that was never there.
 */
export class DisabledOcrProvider implements OcrProvider {
  readonly name = 'none';

  async recognize(request: OcrRequest): Promise<RawPage> {
    throw new AppError(
      'OCR_UNAVAILABLE',
      `"${request.fileName}" needs OCR, which is not configured on this deployment. ` +
        'PDFs that contain a text layer are parsed without OCR; to read scans and images, ' +
        'set OCR_PROVIDER=paddle and point OCR_SERVICE_URL at a PaddleOCR service.',
      { details: { pageNumber: request.pageNumber } },
    );
  }

  async healthCheck(): Promise<OcrHealth> {
    return {
      available: false,
      engine: 'none',
      details: { reason: 'OCR is intentionally disabled (OCR_PROVIDER=none)' },
    };
  }
}
