/**
 * Vercel serverless entry point.
 *
 * The same Fastify application that `npm start` runs is built once per warm
 * instance and handed the raw request. Nothing about the pipeline changes; only
 * the defaults below, which reflect what a serverless host can actually do:
 *
 *  - no PaddleOCR process, so OCR is disabled and only PDFs carrying a text
 *    layer are parsed (set OCR_PROVIDER + OCR_SERVICE_URL in the project's
 *    environment variables to point at a real OCR service and get the rest);
 *  - only /tmp is writable;
 *  - request bodies are capped at 4.5 MB by the platform.
 *
 * Real environment variables set on the project always win over these.
 */
process.env.OCR_PROVIDER ??= 'none';
process.env.UPLOAD_DIR ??= '/tmp/uploads';
process.env.MAX_FILE_SIZE_BYTES ??= '4000000';
process.env.PDF_TEXT_LAYER_ENABLED ??= 'true';
process.env.LOG_PRETTY ??= 'false';

const { createServer } = await import('../dist/server.js');

/** Built once and reused for the lifetime of the instance. */
let appPromise;

function getApp() {
  if (!appPromise) {
    appPromise = createServer().then(async ({ app }) => {
      await app.ready();
      return app;
    });
  }
  return appPromise;
}

export default async function handler(request, response) {
  const app = await getApp();
  app.server.emit('request', request, response);
}
