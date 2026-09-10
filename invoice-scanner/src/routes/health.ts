import type { AppInstance } from '../core/http.js';
import type { AppContainer } from '../container.js';

/**
 * `/health` is a liveness probe (never touches dependencies).
 * `/health/ready` is a readiness probe and does check the OCR back-end.
 */
export async function registerHealthRoutes(app: AppInstance, container: AppContainer): Promise<void> {
  app.get('/health', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    ocrProvider: container.config.OCR_PROVIDER,
    timestamp: new Date().toISOString(),
  }));

  app.get('/health/ready', async (_request, reply) => {
    const health = await container.ocr.healthCheck();
    // OCR_PROVIDER=none is a deliberate deployment mode (text-layer PDFs only),
    // not a degraded service, so it must not fail the readiness probe.
    const ocrDisabled = container.config.OCR_PROVIDER === 'none';
    const ready = ocrDisabled || health.available;

    const body = {
      status: ready ? 'ok' : 'degraded',
      mode: ocrDisabled ? 'pdf-text-layer-only' : 'full',
      ocr: {
        provider: container.config.OCR_PROVIDER,
        available: health.available,
        engine: health.engine ?? null,
        details: health.details ?? null,
      },
      pdfTextLayer: container.config.PDF_TEXT_LAYER_ENABLED,
      timestamp: new Date().toISOString(),
    };
    return reply.code(ready ? 200 : 503).send(body);
  });
}
