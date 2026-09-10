import { describe, expect, it } from 'vitest';
import { AppError } from '../src/core/errors.js';
import type { RawPage } from '../src/core/types.js';
import { getLogger } from '../src/utils/logger.js';
import type { OcrProvider, OcrRequest } from '../src/modules/ocr/provider.js';
import { DocumentProcessor } from '../src/modules/pipeline/documentProcessor.js';
import { InvoicePipeline } from '../src/modules/pipeline/invoicePipeline.js';
import { createTextPdf, NOW, testConfig } from './helpers.js';

/** Fails loudly if the pipeline reaches for OCR when a text layer exists. */
class ExplodingOcrProvider implements OcrProvider {
  readonly name = 'mock';
  calls = 0;

  async recognize(request: OcrRequest): Promise<RawPage> {
    this.calls += 1;
    throw new AppError('OCR_FAILED', `OCR should not have been called for ${request.fileName}`);
  }

  async healthCheck(): Promise<{ available: boolean }> {
    return { available: true };
  }
}

const invoicePage = [
  { text: 'Umbrella Logistics Ltd', x: 50, y: 60, size: 18 },
  { text: 'Company ID 515334221', x: 50, y: 84, size: 10 },
  { text: 'TAX INVOICE', x: 380, y: 60, size: 16 },
  { text: 'Invoice Number: UL-77120', x: 340, y: 100, size: 11 },
  { text: 'Invoice Date: 19/05/2025', x: 340, y: 120, size: 11 },
  { text: 'Due Date: 19/06/2025', x: 340, y: 140, size: 11 },
  { text: 'Bill To: Soylent Foods Inc', x: 50, y: 160, size: 11 },
  { text: 'Freight services April 2025', x: 50, y: 240, size: 11 },
  { text: 'Subtotal', x: 340, y: 600, size: 11 },
  { text: '3,200.00', x: 470, y: 600, size: 11 },
  { text: 'VAT 18%', x: 340, y: 620, size: 11 },
  { text: '576.00', x: 470, y: 620, size: 11 },
  { text: 'Total including VAT', x: 340, y: 640, size: 11 },
  { text: '3,776.00', x: 470, y: 640, size: 11 },
];

describe('PDF text-layer fast path', () => {
  const config = testConfig({ PDF_TEXT_LAYER_ENABLED: 'true' });

  it('reads a digital-born PDF without calling OCR', async () => {
    const ocr = new ExplodingOcrProvider();
    const pipeline = new InvoicePipeline(config, new DocumentProcessor(config, ocr, getLogger()), getLogger());
    const buffer = await createTextPdf([invoicePage]);

    const result = await pipeline.processFile({ fileName: 'umbrella.pdf', buffer }, { now: NOW });

    expect(ocr.calls).toBe(0);
    expect(result.meta.ocrEngine).toBe('pdf-text-layer');
    expect(result.invoice).toMatchObject({
      issuer: 'Umbrella Logistics Ltd',
      invoiceNumber: 'UL-77120',
      invoiceDate: '2025-05-19',
      assignee: 'Soylent Foods Inc',
      invoiceSum: 3200,
      invoiceVat: 576,
      invoiceSumAndVat: 3776,
    });
    expect(result.status).toBe('ok');
  });

  it('flags a day/month ambiguous date for review instead of hiding the guess', async () => {
    const ocr = new ExplodingOcrProvider();
    const pipeline = new InvoicePipeline(config, new DocumentProcessor(config, ocr, getLogger()), getLogger());
    const ambiguous = invoicePage.map((line) =>
      line.text.startsWith('Invoice Date') ? { ...line, text: 'Invoice Date: 09/05/2025' } : line,
    );
    const buffer = await createTextPdf([ambiguous]);

    const result = await pipeline.processFile({ fileName: 'ambiguous.pdf', buffer }, { now: NOW });

    expect(result.invoice.invoiceDate).toBe('2025-05-09');
    expect(result.status).toBe('needs_review');
    expect(result.issues.map((issue) => issue.code)).toContain('AMBIGUOUS_FIELD');
  });

  it('falls back to OCR for pages without a usable text layer', async () => {
    const ocr = new ExplodingOcrProvider();
    const processor = new DocumentProcessor(config, ocr, getLogger());
    // A page with almost no text cannot be read from the text layer.
    const buffer = await createTextPdf([[{ text: 'scan', x: 50, y: 60 }]]);

    await expect(processor.process({ fileName: 'scanned.pdf', buffer })).rejects.toThrow(/OCR should not have been called/);
    expect(ocr.calls).toBe(1);
  });

  it('handles multi-page documents where totals are on the last page', async () => {
    const ocr = new ExplodingOcrProvider();
    const pipeline = new InvoicePipeline(config, new DocumentProcessor(config, ocr, getLogger()), getLogger());
    const buffer = await createTextPdf([
      invoicePage.slice(0, 8),
      [
        { text: 'Umbrella Logistics Ltd - continued', x: 50, y: 60, size: 12 },
        { text: 'Additional handling fees applied in April 2025', x: 50, y: 100, size: 11 },
        ...invoicePage.slice(8),
      ],
    ]);

    const result = await pipeline.processFile({ fileName: 'umbrella-2p.pdf', buffer }, { now: NOW });

    expect(result.meta.pageCount).toBe(2);
    expect(result.invoice.invoiceSumAndVat).toBe(3776);
    expect(result.invoice.invoiceNumber).toBe('UL-77120');
  });
});
