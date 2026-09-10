import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppInstance } from '../src/core/http.js';
import { AppError } from '../src/core/errors.js';
import type { RawPage } from '../src/core/types.js';
import type { OcrProvider, OcrRequest } from '../src/modules/ocr/provider.js';
import { createServer } from '../src/server.js';
import { createBlankPdf, testConfig } from './helpers.js';

/** Builds a multipart body without pulling in an HTTP client dependency. */
function multipart(files: Array<{ field?: string; name: string; content: Buffer; type: string }>): {
  body: Buffer;
  headers: Record<string, string>;
} {
  const boundary = '----invoiceScannerTestBoundary';
  const chunks: Buffer[] = [];
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'files'}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      ),
      file.content,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** Replays fixtures by file name, exactly like the shipped mock provider. */
class FixtureOcrProvider implements OcrProvider {
  readonly name = 'mock';
  failFor: string | null = null;

  async recognize(request: OcrRequest): Promise<RawPage> {
    const withoutPageSuffix = request.fileName.split('#')[0] ?? '';
    const base = path.basename(withoutPageSuffix, path.extname(withoutPageSuffix));
    if (this.failFor && base === this.failFor) {
      throw new AppError('OCR_FAILED', 'simulated OCR failure');
    }
    const fixture = JSON.parse(
      await readFile(path.resolve(process.cwd(), 'tests/fixtures/mock-ocr', `${base}.json`), 'utf8'),
    );
    const pages = fixture.pages ?? [fixture];
    const page = pages[request.pageNumber - 1] ?? pages[0];
    return {
      width: page.width ?? 1000,
      height: page.height ?? 1400,
      engine: 'mock',
      lines: page.lines,
    };
  }

  async healthCheck(): Promise<{ available: boolean }> {
    return { available: true };
  }
}

describe('HTTP API', () => {
  let app: AppInstance;
  const ocr = new FixtureOcrProvider();

  beforeAll(async () => {
    const server = await createServer({ config: testConfig(), ocr });
    app = server.app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports liveness on /health', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('reports readiness on /health/ready', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json().ocr.available).toBe(true);
  });

  it('processes a batch of several invoices in one request', async () => {
    const pdf = await createBlankPdf(1);
    const multipageePdf = await createBlankPdf(2);
    const { body, headers } = multipart([
      { name: 'acme-invoice-en.pdf', content: pdf, type: 'application/pdf' },
      { name: 'hebrew-invoice.pdf', content: pdf, type: 'application/pdf' },
      { name: 'multipage-invoice.pdf', content: multipageePdf, type: 'application/pdf' },
    ]);

    const response = await app.inject({ method: 'POST', url: '/api/invoices', payload: body, headers });
    expect(response.statusCode).toBe(201);

    const payload = response.json();
    expect(payload.summary.total).toBe(3);
    expect(payload.invoices).toHaveLength(3);

    const byFile = Object.fromEntries(
      payload.invoices.map((entry: { invoice: { sourceFileName: string } }) => [entry.invoice.sourceFileName, entry]),
    );

    expect(byFile['acme-invoice-en.pdf'].invoice).toMatchObject({
      issuer: 'ACME Software Ltd',
      invoiceNumber: 'INV-2025-0042',
      invoiceSum: 1250,
      invoiceVat: 225,
      invoiceSumAndVat: 1475,
    });
    expect(byFile['hebrew-invoice.pdf'].invoice.invoiceSumAndVat).toBe(2360);
    expect(byFile['multipage-invoice.pdf'].meta.pageCount).toBe(2);
    expect(byFile['multipage-invoice.pdf'].invoice.invoiceSumAndVat).toBe(4760);
  });

  it('exports a stored batch as JSON and CSV', async () => {
    const pdf = await createBlankPdf(1);
    const { body, headers } = multipart([{ name: 'acme-invoice-en.pdf', content: pdf, type: 'application/pdf' }]);
    const upload = await app.inject({ method: 'POST', url: '/api/invoices', payload: body, headers });
    const batchId = upload.json().batchId as string;

    const json = await app.inject({ method: 'GET', url: `/api/export/${batchId}?format=json` });
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-disposition']).toContain(`invoices-${batchId}.json`);
    expect(JSON.parse(json.body)[0].invoiceNumber).toBe('INV-2025-0042');

    const csv = await app.inject({ method: 'GET', url: `/api/export/${batchId}?format=csv` });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toContain('source_file_name');
    expect(csv.body).toContain('INV-2025-0042');
  });

  it('exposes debug candidates on request', async () => {
    const pdf = await createBlankPdf(1);
    const { body, headers } = multipart([{ name: 'acme-invoice-en.pdf', content: pdf, type: 'application/pdf' }]);
    const response = await app.inject({ method: 'POST', url: '/api/invoices?debug=true', payload: body, headers });

    const debug = response.json().invoices[0].debug;
    expect(debug.candidates.invoiceDate.length).toBeGreaterThan(1);
    expect(debug.pages[0].text).toContain('TAX INVOICE');
  });

  it('retrieves a batch by id and lists batches', async () => {
    const pdf = await createBlankPdf(1);
    const { body, headers } = multipart([{ name: 'acme-invoice-en.pdf', content: pdf, type: 'application/pdf' }]);
    const batchId = (await app.inject({ method: 'POST', url: '/api/invoices', payload: body, headers })).json()
      .batchId as string;

    const fetched = await app.inject({ method: 'GET', url: `/api/invoices/${batchId}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().batchId).toBe(batchId);

    const list = await app.inject({ method: 'GET', url: '/api/batches' });
    expect(list.json().batches.map((batch: { id: string }) => batch.id)).toContain(batchId);
  });

  it('returns 404 for an unknown batch', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/invoices/batch_does_not_exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('rejects unsupported file types', async () => {
    const { body, headers } = multipart([
      { name: 'notes.txt', content: Buffer.from('hello'), type: 'text/plain' },
    ]);
    const response = await app.inject({ method: 'POST', url: '/api/invoices', payload: body, headers });

    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('rejects a request without files', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      payload: Buffer.from('--x--\r\n'),
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('detects a renamed file from its magic bytes', async () => {
    const pdf = await createBlankPdf(1);
    const { body, headers } = multipart([
      { name: 'acme-invoice-en.png', content: pdf, type: 'image/png' },
    ]);
    const response = await app.inject({ method: 'POST', url: '/api/invoices', payload: body, headers });

    // The content is really a PDF, so it is processed as a PDF, not an image.
    expect(response.json().invoices[0].meta.mimeType).toBe('application/pdf');
  });

  it('keeps a failing file from breaking the rest of the batch', async () => {
    ocr.failFor = 'quotation';
    try {
      const pdf = await createBlankPdf(1);
      const { body, headers } = multipart([
        { name: 'acme-invoice-en.pdf', content: pdf, type: 'application/pdf' },
        { name: 'quotation.pdf', content: pdf, type: 'application/pdf' },
      ]);
      const response = await app.inject({ method: 'POST', url: '/api/invoices', payload: body, headers });
      const payload = response.json();

      expect(payload.invoices).toHaveLength(1);
      expect(payload.rejected).toHaveLength(1);
      expect(payload.rejected[0]).toMatchObject({ sourceFileName: 'quotation.pdf', code: 'OCR_FAILED' });
      expect(payload.summary.failed).toBe(1);
    } finally {
      ocr.failFor = null;
    }
  });

  it('exports an arbitrary invoice array via POST /api/export', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/export',
      payload: {
        format: 'csv',
        invoices: [
          {
            issuer: 'Edited Ltd',
            invoiceDate: '2025-01-01',
            invoiceNumber: 'X-1',
            assignee: null,
            invoiceSum: 100,
            invoiceVat: 18,
            invoiceSumAndVat: 118,
            sourceFileName: 'edited.pdf',
            warnings: [],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Edited Ltd');
  });

  it('serves the upload UI', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Invoice Scanner');
  });
});
