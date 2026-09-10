import { describe, expect, it } from 'vitest';
import type { DocumentQuality, Invoice } from '../src/core/types.js';
import { mapDocumentToInvoice } from '../src/modules/parsing/fieldMapper.js';
import { validateInvoice } from '../src/modules/validation/invoiceValidator.js';
import { loadFixtureDocument, NOW, testConfig } from './helpers.js';

const config = testConfig();

const goodQuality: DocumentQuality = {
  classification: 'invoice',
  invoiceScore: 0.9,
  meanOcrConfidence: 0.95,
  totalCharacters: 400,
  matchedKeywords: [],
  detectedLanguages: ['en'],
};

function invoiceOf(overrides: Partial<Invoice> = {}): Invoice {
  return {
    issuer: 'ACME Software Ltd',
    invoiceDate: '2025-03-14',
    invoiceNumber: 'INV-1',
    assignee: 'Globex Industries Ltd',
    invoiceSum: 1000,
    invoiceVat: 180,
    invoiceSumAndVat: 1180,
    sourceFileName: 'invoice.pdf',
    warnings: [],
    ...overrides,
  };
}

describe('validateInvoice', () => {
  it('accepts a consistent invoice', () => {
    const result = validateInvoice({
      invoice: invoiceOf(),
      quality: goodQuality,
      fieldConfidence: { issuer: 0.8, invoiceDate: 0.9, invoiceNumber: 0.8, invoiceSumAndVat: 0.9 },
      vatRate: 18,
      config,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    expect(result.issues).toHaveLength(0);
  });

  it('detects sum + vat != total', () => {
    const result = validateInvoice({
      invoice: invoiceOf({ invoiceSumAndVat: 1190 }),
      quality: goodQuality,
      fieldConfidence: {},
      vatRate: 18,
      config,
      now: NOW,
    });

    expect(result.status).toBe('failed');
    expect(result.issues.map((issue) => issue.code)).toContain('AMOUNT_MISMATCH');
  });

  it('accepts rounding differences inside the tolerance', () => {
    const result = validateInvoice({
      invoice: invoiceOf({ invoiceSum: 1000, invoiceVat: 180.01, invoiceSumAndVat: 1180 }),
      quality: goodQuality,
      fieldConfidence: {},
      vatRate: 18,
      config,
      now: NOW,
    });

    expect(result.issues.map((issue) => issue.code)).not.toContain('AMOUNT_MISMATCH');
  });

  it('reports missing required fields', () => {
    const result = validateInvoice({
      invoice: invoiceOf({ invoiceNumber: null, issuer: null }),
      quality: goodQuality,
      fieldConfidence: {},
      vatRate: 18,
      config,
      now: NOW,
    });

    const missing = result.issues.filter((issue) => issue.code === 'MISSING_FIELD').map((issue) => issue.field);
    expect(missing).toEqual(expect.arrayContaining(['issuer', 'invoiceNumber']));
    expect(result.status).toBe('needs_review');
  });

  it('flags an implausible VAT rate', () => {
    const result = validateInvoice({
      invoice: invoiceOf({ invoiceSum: 1000, invoiceVat: 55, invoiceSumAndVat: 1055 }),
      quality: goodQuality,
      fieldConfidence: {},
      vatRate: 5.5,
      config,
      now: NOW,
    });

    expect(result.issues.map((issue) => issue.code)).toContain('UNEXPECTED_VAT_RATE');
  });

  it('flags future dates', () => {
    const result = validateInvoice({
      invoice: invoiceOf({ invoiceDate: '2030-01-01' }),
      quality: goodQuality,
      fieldConfidence: {},
      vatRate: 18,
      config,
      now: NOW,
    });

    expect(result.issues.map((issue) => issue.code)).toContain('FUTURE_DATE');
  });

  it('fails documents that are not invoices', () => {
    const result = validateInvoice({
      invoice: invoiceOf(),
      quality: { ...goodQuality, classification: 'not-an-invoice', invoiceScore: 0.1 },
      fieldConfidence: {},
      vatRate: 18,
      config,
      now: NOW,
    });

    expect(result.status).toBe('failed');
    expect(result.issues.map((issue) => issue.code)).toContain('NOT_AN_INVOICE');
  });

  it('reports an arithmetic mismatch found in a real fixture', async () => {
    const document = await loadFixtureDocument('amount-mismatch', config);
    const mapped = mapDocumentToInvoice(document, config, NOW);
    const result = validateInvoice({
      invoice: mapped.invoice,
      quality: mapped.quality,
      fieldConfidence: mapped.fieldConfidence,
      vatRate: mapped.vatRate,
      config,
      now: NOW,
    });

    // 1000 + 180 != 1190: the reconciler must not silently "fix" the document.
    expect(mapped.reconciled).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('AMOUNT_MISMATCH');
    expect(result.status).toBe('failed');
  });
});
