import { describe, expect, it } from 'vitest';
import type { InvoiceBatch, ProcessedInvoice } from '../src/core/types.js';
import { exportCsv, exportJson, toInvoiceArray } from '../src/modules/export/index.js';

function processed(overrides: Partial<ProcessedInvoice['invoice']> = {}, status: ProcessedInvoice['status'] = 'ok'): ProcessedInvoice {
  return {
    id: 'inv_1',
    status,
    invoice: {
      issuer: 'ACME Software Ltd',
      invoiceDate: '2025-03-14',
      invoiceNumber: 'INV-2025-0042',
      assignee: 'Globex Industries Ltd',
      invoiceSum: 1250,
      invoiceVat: 225,
      invoiceSumAndVat: 1475,
      sourceFileName: 'acme.pdf',
      warnings: [],
      ...overrides,
    },
    quality: {
      classification: 'invoice',
      invoiceScore: 0.9,
      meanOcrConfidence: 0.95,
      totalCharacters: 300,
      matchedKeywords: [],
      detectedLanguages: ['en'],
    },
    issues: [],
    fieldConfidence: { issuer: 0.8 },
    meta: {
      sourceFileName: 'acme.pdf',
      mimeType: 'application/pdf',
      byteSize: 1024,
      pageCount: 1,
      ocrEngine: 'mock',
      languages: ['en'],
      processingMs: 12,
    },
  };
}

function batchOf(invoices: ProcessedInvoice[], rejected: InvoiceBatch['rejected'] = []): InvoiceBatch {
  return {
    id: 'batch_test',
    createdAt: '2025-08-01T09:00:00.000Z',
    completedAt: '2025-08-01T09:00:01.000Z',
    summary: {
      total: invoices.length + rejected.length,
      ok: invoices.filter((invoice) => invoice.status === 'ok').length,
      needsReview: invoices.filter((invoice) => invoice.status === 'needs_review').length,
      failed: rejected.length,
    },
    invoices,
    rejected,
  };
}

describe('JSON export', () => {
  it('exports exactly the normalised schema', () => {
    const result = exportJson(batchOf([processed()]));
    const parsed = JSON.parse(result.body);

    expect(result.contentType).toContain('application/json');
    expect(result.fileName).toBe('invoices-batch_test.json');
    expect(parsed).toHaveLength(1);
    expect(Object.keys(parsed[0]).sort()).toEqual(
      [
        'assignee',
        'invoiceDate',
        'invoiceNumber',
        'invoiceSum',
        'invoiceSumAndVat',
        'invoiceVat',
        'issuer',
        'sourceFileName',
        'warnings',
      ].sort(),
    );
  });

  it('keeps nulls rather than dropping unknown fields', () => {
    const [invoice] = toInvoiceArray(batchOf([processed({ assignee: null })]));
    expect(invoice?.assignee).toBeNull();
  });
});

describe('CSV export', () => {
  it('writes one row per invoice with a header', () => {
    const result = exportCsv(batchOf([processed(), processed({ sourceFileName: 'second.pdf' })]));
    const lines = result.body.trimEnd().split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('invoice_sum_and_vat');
    expect(lines[1]).toContain('INV-2025-0042');
  });

  it('starts with a UTF-8 BOM so Excel renders Hebrew correctly', () => {
    const result = exportCsv(batchOf([processed({ issuer: 'אלפא טכנולוגיות בע"מ' })]));
    expect(result.body.startsWith('﻿')).toBe(true);
    expect(result.body).toContain('אלפא טכנולוגיות');
  });

  it('quotes values that contain separators', () => {
    const result = exportCsv(batchOf([processed({ issuer: 'Foo, Bar & Co' })]));
    expect(result.body).toContain('"Foo, Bar & Co"');
  });

  it('includes a row for files that could not be processed', () => {
    const result = exportCsv(
      batchOf([processed()], [{ sourceFileName: 'broken.pdf', code: 'OCR_FAILED', message: 'engine exploded' }]),
    );

    expect(result.body).toContain('broken.pdf');
    expect(result.body).toContain('[OCR_FAILED] engine exploded');
  });

  it('renders empty cells for null amounts', () => {
    const result = exportCsv(batchOf([processed({ invoiceVat: null })]));
    const dataRow = result.body.trimEnd().split('\n')[1] ?? '';
    expect(dataRow.split(',')).toContain('');
  });
});
