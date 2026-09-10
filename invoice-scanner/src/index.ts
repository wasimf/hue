import { getConfig } from './config/index.js';
import { createServer } from './server.js';
import { getLogger } from './utils/logger.js';

async function main(): Promise<void> {
  const config = getConfig();
  const logger = getLogger();
  const { app, container } = await createServer();

  const health = await container.ocr.healthCheck();
  if (!health.available) {
    logger.warn(
      { provider: config.OCR_PROVIDER, details: health.details },
      'the OCR back-end is not reachable; uploads of scanned documents will fail until it is up',
    );
  }

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ url: `http://${config.HOST}:${config.PORT}` }, 'invoice-scanner is listening');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  // The logger may not exist yet if configuration failed to load.
  console.error('failed to start invoice-scanner:', error);
  process.exit(1);
});
