import { stringify } from 'csv-stringify/sync';
import type { Invoice, InvoiceBatch, ProcessedInvoice } from '../../core/types.js';

export type ExportFormat = 'json' | 'csv';

export interface ExportResult {
  body: string;
  contentType: string;
  fileName: string;
}

/** Excel only detects UTF-8 in CSV when a BOM is present – Hebrew needs it. */
const UTF8_BOM = '﻿';

export const CSV_COLUMNS = [
  { key: 'sourceFileName', header: 'source_file_name' },
  { key: 'issuer', header: 'issuer' },
  { key: 'invoiceDate', header: 'invoice_date' },
  { key: 'invoiceNumber', header: 'invoice_number' },
  { key: 'assignee', header: 'assignee' },
  { key: 'invoiceSum', header: 'invoice_sum' },
  { key: 'invoiceVat', header: 'invoice_vat' },
  { key: 'invoiceSumAndVat', header: 'invoice_sum_and_vat' },
  { key: 'status', header: 'status' },
  { key: 'pageCount', header: 'page_count' },
  { key: 'classification', header: 'document_classification' },
  { key: 'warnings', header: 'warnings' },
] as const;

/** The exported JSON payload is exactly the normalised schema, nothing else. */
export function toInvoiceArray(batch: InvoiceBatch): Invoice[] {
  return batch.invoices.map((processed) => processed.invoice);
}

export function exportJson(batch: InvoiceBatch, options: { pretty?: boolean } = {}): ExportResult {
  const payload = toInvoiceArray(batch);
  return {
    body: JSON.stringify(payload, null, options.pretty === false ? 0 : 2),
    contentType: 'application/json; charset=utf-8',
    fileName: `invoices-${batch.id}.json`,
  };
}

function toCsvRow(processed: ProcessedInvoice): Record<string, string | number | null> {
  const { invoice } = processed;
  return {
    sourceFileName: invoice.sourceFileName,
    issuer: invoice.issuer,
    invoiceDate: invoice.invoiceDate,
    invoiceNumber: invoice.invoiceNumber,
    assignee: invoice.assignee,
    invoiceSum: invoice.invoiceSum,
    invoiceVat: invoice.invoiceVat,
    invoiceSumAndVat: invoice.invoiceSumAndVat,
    status: processed.status,
    pageCount: processed.meta.pageCount,
    classification: processed.quality.classification,
    warnings: invoice.warnings.join(' | '),
  };
}

export function exportCsv(batch: InvoiceBatch): ExportResult {
  const rows = batch.invoices.map(toCsvRow);
  // Rejected files still deserve a row so the CSV accounts for every upload.
  for (const rejection of batch.rejected) {
    rows.push({
      sourceFileName: rejection.sourceFileName,
      issuer: null,
      invoiceDate: null,
      invoiceNumber: null,
      assignee: null,
      invoiceSum: null,
      invoiceVat: null,
      invoiceSumAndVat: null,
      status: 'failed',
      pageCount: 0,
      classification: 'unreadable',
      warnings: `[${rejection.code}] ${rejection.message}`,
    });
  }

  const body = stringify(rows, {
    header: true,
    columns: CSV_COLUMNS.map((column) => ({ key: column.key, header: column.header })),
    cast: { number: (value) => String(value) },
  });

  return {
    body: `${UTF8_BOM}${body}`,
    contentType: 'text/csv; charset=utf-8',
    fileName: `invoices-${batch.id}.csv`,
  };
}

export function exportBatch(batch: InvoiceBatch, format: ExportFormat): ExportResult {
  return format === 'csv' ? exportCsv(batch) : exportJson(batch);
}
