import type { AppConfig } from '../../config/index.js';
import { MockOcrProvider } from './mockProvider.js';
import { PaddleOcrProvider } from './paddleProvider.js';
import type { OcrProvider } from './provider.js';

export type { OcrProvider, OcrRequest, OcrHealth } from './provider.js';
export { PaddleOcrProvider } from './paddleProvider.js';
export { MockOcrProvider } from './mockProvider.js';

/** Registry of available OCR back-ends. */
export function createOcrProvider(config: AppConfig): OcrProvider {
  switch (config.OCR_PROVIDER) {
    case 'mock':
      return new MockOcrProvider(config.mockOcrDirAbsolute);
    case 'paddle':
    default:
      return new PaddleOcrProvider(config);
  }
}
