import type { Logger } from 'pino';
import { getConfig, type AppConfig } from './config/index.js';
import { createOcrProvider } from './modules/ocr/index.js';
import type { OcrProvider } from './modules/ocr/provider.js';
import { DocumentProcessor } from './modules/pipeline/documentProcessor.js';
import { InvoicePipeline } from './modules/pipeline/invoicePipeline.js';
import { InMemoryBatchRepository, type BatchRepository } from './modules/store/batchRepository.js';
import { UploadStore } from './modules/upload/uploadStore.js';
import { getLogger } from './utils/logger.js';

export interface AppContainer {
  config: AppConfig;
  logger: Logger;
  ocr: OcrProvider;
  processor: DocumentProcessor;
  pipeline: InvoicePipeline;
  batches: BatchRepository;
  uploads: UploadStore;
}

export interface ContainerOverrides {
  config?: AppConfig;
  logger?: Logger;
  ocr?: OcrProvider;
  batches?: BatchRepository;
}

/**
 * Composition root. Every dependency is constructed here and injected, which
 * is what makes the OCR engine and the batch storage swappable (and the whole
 * pipeline testable without HTTP).
 */
export function createContainer(overrides: ContainerOverrides = {}): AppContainer {
  const config = overrides.config ?? getConfig();
  const logger = overrides.logger ?? getLogger();
  const ocr = overrides.ocr ?? createOcrProvider(config);
  const processor = new DocumentProcessor(config, ocr, logger);
  const pipeline = new InvoicePipeline(config, processor, logger);
  const batches = overrides.batches ?? new InMemoryBatchRepository(config.BATCH_TTL_MS, config.MAX_BATCHES_IN_MEMORY);
  const uploads = new UploadStore(config, logger);

  return { config, logger, ocr, processor, pipeline, batches, uploads };
}
