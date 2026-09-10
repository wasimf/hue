import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/core/errors.js';
import { PaddleOcrProvider } from '../src/modules/ocr/paddleProvider.js';
import { testConfig } from './helpers.js';

/**
 * A stand-in for `ocr-service/app.py` that implements the documented contract.
 * It lets the client — multipart upload, response validation, retries, health,
 * error mapping — be verified without Python or the PaddleOCR models.
 */
interface StubState {
  ocrStatus: number;
  ocrBody: unknown;
  healthStatus: number;
  healthBody: unknown;
  requests: Array<{ contentType: string; body: string }>;
}

const state: StubState = {
  ocrStatus: 200,
  ocrBody: {
    engine: 'paddleocr:en',
    languages: ['en'],
    pages: [
      {
        page_number: 1,
        width: 1654,
        height: 2339,
        lines: [
          { text: 'Total including VAT', confidence: 0.987, box: { x0: 1032, y0: 1904, x1: 1338, y1: 1937 } },
          { text: '1,475.00', confidence: 0.991, box: { x0: 1400, y0: 1904, x1: 1560, y1: 1937 } },
        ],
        warnings: [],
      },
    ],
  },
  healthStatus: 200,
  healthBody: { status: 'ok', engine: 'paddleocr', languages: ['en'], models_loaded: true },
  requests: [],
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url === '/health') {
        response.writeHead(state.healthStatus, { 'content-type': 'application/json' });
        response.end(JSON.stringify(state.healthBody));
        return;
      }
      state.requests.push({
        contentType: request.headers['content-type'] ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(state.ocrStatus, { 'content-type': 'application/json' });
      response.end(typeof state.ocrBody === 'string' ? state.ocrBody : JSON.stringify(state.ocrBody));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

function provider(overrides: Record<string, string> = {}): PaddleOcrProvider {
  return new PaddleOcrProvider(
    testConfig({ OCR_PROVIDER: 'paddle', OCR_SERVICE_URL: baseUrl, OCR_MAX_RETRIES: '1', ...overrides }),
  );
}

const request = {
  buffer: Buffer.from('%PDF-1.7 fake page'),
  fileName: 'invoice.pdf#page-2',
  mimeType: 'application/pdf',
  pageNumber: 2,
  languages: ['en', 'he'],
};

describe('PaddleOcrProvider', () => {
  it('posts the page as multipart and maps the response onto RawPage', async () => {
    state.requests.length = 0;
    const page = await provider().recognize(request);

    expect(page.width).toBe(1654);
    expect(page.engine).toBe('paddleocr:en');
    expect(page.lines[0]).toMatchObject({ text: 'Total including VAT', confidence: 0.987 });
    expect(page.lines[0]?.box).toEqual({ x0: 1032, y0: 1904, x1: 1338, y1: 1937 });

    const sent = state.requests[0];
    expect(sent?.contentType).toContain('multipart/form-data');
    expect(sent?.body).toContain('name="file"; filename="invoice.pdf#page-2"');
    expect(sent?.body).toContain('name="languages"');
    expect(sent?.body).toContain('en,he');
    expect(sent?.body).toContain('name="dpi"');
  });

  it('reports the service as unavailable and retries on 5xx', async () => {
    state.ocrStatus = 500;
    state.ocrBody = { detail: 'model crashed' };
    state.requests.length = 0;

    try {
      await expect(provider().recognize(request)).rejects.toMatchObject({ code: 'OCR_UNAVAILABLE' });
      // One initial attempt plus OCR_MAX_RETRIES=1.
      expect(state.requests).toHaveLength(2);
    } finally {
      state.ocrStatus = 200;
    }
  });

  it('does not retry a 4xx and reports it as a page failure', async () => {
    state.ocrStatus = 422;
    state.ocrBody = { detail: 'the document contained no pages' };
    state.requests.length = 0;

    try {
      const error = await provider().recognize(request).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('OCR_FAILED');
      expect(state.requests).toHaveLength(1);
    } finally {
      state.ocrStatus = 200;
    }
  });

  it('rejects a payload that does not match the contract', async () => {
    const valid = state.ocrBody;
    state.ocrBody = { engine: 'paddleocr', pages: [{ page_number: 1, width: 10 }] };

    try {
      await expect(provider().recognize(request)).rejects.toMatchObject({ code: 'OCR_FAILED' });
    } finally {
      state.ocrBody = valid;
    }
  });

  it('reads the health endpoint', async () => {
    const health = await provider().healthCheck();
    expect(health).toMatchObject({ available: true, engine: 'paddleocr' });
  });

  it('reports degraded health without throwing', async () => {
    state.healthStatus = 503;
    state.healthBody = { status: 'degraded', missing_dependencies: ['paddleocr'] };

    try {
      const health = await provider().healthCheck();
      expect(health.available).toBe(false);
    } finally {
      state.healthStatus = 200;
      state.healthBody = { status: 'ok', engine: 'paddleocr', languages: ['en'], models_loaded: true };
    }
  });

  it('reports an unreachable service rather than hanging', async () => {
    const unreachable = new PaddleOcrProvider(
      testConfig({ OCR_PROVIDER: 'paddle', OCR_SERVICE_URL: 'http://127.0.0.1:1', OCR_MAX_RETRIES: '0' }),
    );

    await expect(unreachable.recognize(request)).rejects.toMatchObject({ code: 'OCR_UNAVAILABLE' });
    expect((await unreachable.healthCheck()).available).toBe(false);
  });
});
