import { describe, expect, it } from 'vitest';
import { findDates } from '../src/modules/parsing/dates.js';
import { mapDocumentToInvoice } from '../src/modules/parsing/fieldMapper.js';
import { matchKeyword } from '../src/modules/parsing/keywords.js';
import { extractNumericTokens, parseAmount } from '../src/modules/parsing/number.js';
import { loadFixtureDocument, NOW, testConfig } from './helpers.js';

const config = testConfig();

describe('amount parsing', () => {
  it.each([
    ['1,234.56', 1234.56],
    ['1.234,56', 1234.56],
    ['1 234,56', 1234.56],
    ['1234', 1234],
    ['0.50', 0.5],
    ['1.234', 1234],
    ['1,234', 1234],
    ['12.5', 12.5],
    ['(1,234.56)', -1234.56],
    ['-99.90', -99.9],
    ['1.234.567,89', 1234567.89],
  ])('parses %s', (input, expected) => {
    expect(parseAmount(input)).toBeCloseTo(expected, 2);
  });

  it('returns null for text without digits', () => {
    expect(parseAmount('Total due')).toBeNull();
  });

  it('keeps adjacent amounts separate', () => {
    const tokens = extractNumericTokens('120.00 300.00');
    expect(tokens.map((token) => token.value)).toEqual([120, 300]);
  });

  it('flags percentages so VAT rates are not read as amounts', () => {
    const tokens = extractNumericTokens('VAT 18% 225.00');
    expect(tokens[0]?.isPercent).toBe(true);
    expect(tokens[1]?.value).toBe(225);
  });
});

describe('date parsing', () => {
  it('reads DMY by default', () => {
    expect(findDates('Invoice Date: 03/04/2025', 'DMY')[0]?.iso).toBe('2025-04-03');
  });

  it('honours the MDY preference', () => {
    expect(findDates('Invoice Date: 03/04/2025', 'MDY')[0]?.iso).toBe('2025-03-04');
  });

  it('flags ambiguous day/month values', () => {
    expect(findDates('03/04/2025')[0]?.ambiguous).toBe(true);
    expect(findDates('25/04/2025')[0]?.ambiguous).toBe(false);
  });

  it.each([
    ['2025-03-14', '2025-03-14'],
    ['14.03.2025', '2025-03-14'],
    ['14 March 2025', '2025-03-14'],
    ['March 14, 2025', '2025-03-14'],
    ['20250314', '2025-03-14'],
    ['14/03/25', '2025-03-14'],
  ])('normalises %s', (input, expected) => {
    expect(findDates(input, 'DMY')[0]?.iso).toBe(expected);
  });

  it('rejects impossible dates', () => {
    expect(findDates('32/13/2025')).toHaveLength(0);
  });

  it('parses Hebrew month names', () => {
    expect(findDates('5 בפברואר 2025', 'DMY')[0]?.iso).toBe('2025-02-05');
  });
});

describe('keyword matching', () => {
  it('matches Hebrew terms regardless of gershayim style', () => {
    expect(matchKeyword('מע"מ 18%', 'vat')?.term).toBeDefined();
    expect(matchKeyword('מע״מ 18%', 'vat')?.term).toBeDefined();
    expect(matchKeyword('מעמ 18%', 'vat')?.term).toBeDefined();
  });

  it('prefers the longest matching term', () => {
    expect(matchKeyword('Total including VAT', 'total')?.term).toBe('total including vat');
  });

  it('detects label-only cells', () => {
    expect(matchKeyword('Bill To:', 'billTo')?.isLabelOnly).toBe(true);
    expect(matchKeyword('Bill To: Globex Industries Ltd', 'billTo')?.isLabelOnly).toBe(false);
  });
});

describe('end-to-end field mapping', () => {
  it('extracts every field from an English invoice', async () => {
    const document = await loadFixtureDocument('acme-invoice-en', config);
    const { invoice, quality } = mapDocumentToInvoice(document, config, NOW);

    expect(quality.classification).toBe('invoice');
    expect(invoice.issuer).toBe('ACME Software Ltd');
    expect(invoice.invoiceNumber).toBe('INV-2025-0042');
    expect(invoice.invoiceDate).toBe('2025-03-14');
    expect(invoice.assignee).toBe('Globex Industries Ltd');
    expect(invoice.invoiceSum).toBe(1250);
    expect(invoice.invoiceVat).toBe(225);
    expect(invoice.invoiceSumAndVat).toBe(1475);
  });

  it('prefers the invoice date over the due date', async () => {
    const document = await loadFixtureDocument('acme-invoice-en', config);
    const { invoice } = mapDocumentToInvoice(document, config, NOW);
    expect(invoice.invoiceDate).not.toBe('2025-04-14');
  });

  it('extracts every field from a Hebrew invoice', async () => {
    const document = await loadFixtureDocument('hebrew-invoice', config);
    const { invoice, quality } = mapDocumentToInvoice(document, config, NOW);

    expect(quality.detectedLanguages).toContain('he');
    expect(invoice.issuer).toBe('אלפא טכנולוגיות בע"מ');
    expect(invoice.assignee).toBe('גלובקס תעשיות בע"מ');
    expect(invoice.invoiceDate).toBe('2025-02-05');
    expect(invoice.invoiceNumber).toBe('2025-118');
    expect(invoice.invoiceSum).toBe(2000);
    expect(invoice.invoiceVat).toBe(360);
    expect(invoice.invoiceSumAndVat).toBe(2360);
  });

  it('reads totals that appear on a later page', async () => {
    const document = await loadFixtureDocument('multipage-invoice', config);
    const { invoice } = mapDocumentToInvoice(document, config, NOW);

    expect(document.pageCount).toBe(2);
    expect(invoice.invoiceNumber).toBe('2025/0771');
    expect(invoice.invoiceDate).toBe('2025-01-09');
    expect(invoice.invoiceSum).toBe(4000);
    expect(invoice.invoiceVat).toBe(760);
    expect(invoice.invoiceSumAndVat).toBe(4760);
  });

  it('marks a quotation as not an invoice', async () => {
    const document = await loadFixtureDocument('quotation', config);
    const { quality } = mapDocumentToInvoice(document, config, NOW);
    expect(quality.classification).toBe('not-an-invoice');
  });

  it('marks unreadable scans and reports null fields with warnings', async () => {
    const document = await loadFixtureDocument('low-quality', config);
    const { invoice, quality } = mapDocumentToInvoice(document, config, NOW);

    expect(quality.classification).toBe('unreadable');
    expect(invoice.invoiceSumAndVat).toBeNull();
    expect(invoice.warnings.some((warning) => warning.includes('could not be found'))).toBe(true);
  });

  it('keeps rejected alternatives available for debugging', async () => {
    const document = await loadFixtureDocument('acme-invoice-en', config);
    const { extractions } = mapDocumentToInvoice(document, config, NOW);

    const dateAlternatives = extractions.invoiceDate.alternatives.map((candidate) => candidate.value);
    expect(dateAlternatives).toContain('2025-04-14');
  });
});
