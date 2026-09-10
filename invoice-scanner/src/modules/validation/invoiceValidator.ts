import type { AppConfig } from '../../config/index.js';
import type {
  DocumentQuality,
  Invoice,
  InvoiceFieldName,
  InvoiceStatus,
  ValidationIssue,
} from '../../core/types.js';
import { amountsMatch, roundMoney } from '../parsing/number.js';

export interface ValidationInput {
  invoice: Invoice;
  quality: DocumentQuality;
  fieldConfidence: Partial<Record<InvoiceFieldName, number>>;
  /** Fields the mapper could not decide with confidence. */
  ambiguousFields?: InvoiceFieldName[];
  vatRate: number | null;
  config: AppConfig;
  now?: Date;
}

export interface ValidationResult {
  status: InvoiceStatus;
  issues: ValidationIssue[];
}

const REQUIRED_FIELDS: InvoiceFieldName[] = [
  'issuer',
  'invoiceDate',
  'invoiceNumber',
  'invoiceSumAndVat',
];

/**
 * Validates a mapped invoice.
 *
 * Rules are additive and each produces a coded issue so downstream consumers
 * (UI, export, future DB triage) can filter without string matching.
 */
export function validateInvoice(input: ValidationInput): ValidationResult {
  const { invoice, quality, fieldConfidence, config } = input;
  const now = input.now ?? new Date();
  const issues: ValidationIssue[] = [];

  const add = (issue: ValidationIssue): void => {
    issues.push(issue);
  };

  // --- Document level -------------------------------------------------------
  if (quality.classification === 'unreadable') {
    add({
      code: 'DOCUMENT_UNREADABLE',
      severity: 'error',
      message: `The document could not be read reliably (mean OCR confidence ${quality.meanOcrConfidence}, ${quality.totalCharacters} characters recognised)`,
    });
  } else if (quality.classification === 'not-an-invoice') {
    add({
      code: 'NOT_AN_INVOICE',
      severity: 'error',
      message: `The document does not look like an invoice (score ${quality.invoiceScore})`,
    });
  } else if (quality.classification === 'probably-invoice') {
    add({
      code: 'WEAK_INVOICE_SIGNALS',
      severity: 'warning',
      message: `Few invoice keywords were found (score ${quality.invoiceScore}); the extracted fields need review`,
    });
  }

  if (quality.meanOcrConfidence > 0 && quality.meanOcrConfidence < config.LOW_QUALITY_CONFIDENCE) {
    add({
      code: 'LOW_OCR_CONFIDENCE',
      severity: 'warning',
      message: `Mean OCR confidence ${quality.meanOcrConfidence} is below the ${config.LOW_QUALITY_CONFIDENCE} threshold; consider rescanning at a higher resolution`,
    });
  }

  // --- Missing fields -------------------------------------------------------
  for (const field of REQUIRED_FIELDS) {
    if (invoice[field] === null) {
      add({ code: 'MISSING_FIELD', severity: 'warning', field, message: `Required field "${field}" is missing` });
    }
  }
  for (const field of ['assignee', 'invoiceSum', 'invoiceVat'] as InvoiceFieldName[]) {
    if (invoice[field] === null) {
      add({ code: 'MISSING_OPTIONAL_FIELD', severity: 'info', field, message: `Field "${field}" is missing` });
    }
  }

  for (const field of input.ambiguousFields ?? []) {
    add({
      code: 'AMBIGUOUS_FIELD',
      severity: 'warning',
      field,
      message: `Field "${field}" had more than one plausible value; the most likely one was kept (alternatives are in the debug output)`,
    });
  }

  for (const [field, confidence] of Object.entries(fieldConfidence) as Array<[InvoiceFieldName, number]>) {
    if (confidence < 0.5) {
      add({
        code: 'LOW_FIELD_CONFIDENCE',
        severity: 'warning',
        field,
        message: `Field "${field}" was extracted with low confidence (${confidence})`,
      });
    }
  }

  // --- Arithmetic -----------------------------------------------------------
  const { invoiceSum, invoiceVat, invoiceSumAndVat } = invoice;
  const tolerance = { absolute: config.AMOUNT_TOLERANCE_ABS, relative: config.AMOUNT_TOLERANCE_REL };

  if (invoiceSum !== null && invoiceVat !== null && invoiceSumAndVat !== null) {
    const expected = roundMoney(invoiceSum + invoiceVat);
    if (!amountsMatch(expected, invoiceSumAndVat, tolerance)) {
      add({
        code: 'AMOUNT_MISMATCH',
        severity: 'error',
        field: 'invoiceSumAndVat',
        message: `invoiceSum + invoiceVat = ${expected} does not match invoiceSumAndVat = ${invoiceSumAndVat}`,
      });
    }
  } else if (invoiceSumAndVat !== null && (invoiceSum === null || invoiceVat === null)) {
    add({
      code: 'AMOUNT_INCOMPLETE',
      severity: 'warning',
      message: 'The sum/VAT breakdown is incomplete, so the total could not be cross-checked',
    });
  }

  for (const field of ['invoiceSum', 'invoiceVat', 'invoiceSumAndVat'] as const) {
    const value = invoice[field];
    if (value !== null && value < 0) {
      add({
        code: 'NEGATIVE_AMOUNT',
        severity: 'warning',
        field,
        message: `Field "${field}" is negative (${value}); this may be a credit note`,
      });
    }
  }

  if (input.vatRate !== null && invoiceVat !== null && invoiceVat !== 0) {
    const known = config.EXPECTED_VAT_RATES.some((rate) => Math.abs(input.vatRate! - rate) <= 0.6);
    if (!known) {
      add({
        code: 'UNEXPECTED_VAT_RATE',
        severity: 'warning',
        field: 'invoiceVat',
        message: `Implied VAT rate ${input.vatRate}% is not one of the expected rates (${config.EXPECTED_VAT_RATES.join(', ')})`,
      });
    }
  }

  // --- Date sanity ----------------------------------------------------------
  if (invoice.invoiceDate !== null) {
    const parsed = Date.parse(`${invoice.invoiceDate}T00:00:00Z`);
    if (!Number.isFinite(parsed)) {
      add({
        code: 'INVALID_DATE',
        severity: 'error',
        field: 'invoiceDate',
        message: `Invoice date "${invoice.invoiceDate}" is not a valid ISO date`,
      });
    } else if (parsed > now.getTime() + 3 * 24 * 60 * 60 * 1000) {
      add({
        code: 'FUTURE_DATE',
        severity: 'warning',
        field: 'invoiceDate',
        message: `Invoice date ${invoice.invoiceDate} is in the future`,
      });
    }
  }

  const hasError = issues.some((issue) => issue.severity === 'error');
  const hasWarning = issues.some((issue) => issue.severity === 'warning');
  const status: InvoiceStatus = hasError ? 'failed' : hasWarning ? 'needs_review' : 'ok';

  return { status, issues };
}

/** Appends validation messages to the invoice's own warnings array. */
export function applyIssuesToInvoice(invoice: Invoice, issues: ValidationIssue[]): void {
  for (const issue of issues) {
    if (issue.severity === 'info') continue;
    const message = `[${issue.code}] ${issue.message}`;
    if (!invoice.warnings.includes(message)) invoice.warnings.push(message);
  }
}
