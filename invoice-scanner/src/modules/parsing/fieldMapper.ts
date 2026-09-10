import type { AppConfig } from '../../config/index.js';
import type {
  DocumentQuality,
  FieldCandidate,
  FieldExtraction,
  Invoice,
  InvoiceFieldName,
  OcrDocument,
} from '../../core/types.js';
import { FIELD_LABELS, type ExtractionContext } from './context.js';
import { classifyDocument } from './documentClassifier.js';
import { extractAmounts } from './extractors/amounts.js';
import { extractInvoiceDate } from './extractors/dateExtractor.js';
import { extractInvoiceNumber } from './extractors/invoiceNumber.js';
import { extractAssignee, extractIssuer } from './extractors/parties.js';
import { DocumentLayout } from './layout.js';

export interface MappedInvoice {
  invoice: Invoice;
  quality: DocumentQuality;
  fieldConfidence: Partial<Record<InvoiceFieldName, number>>;
  /** Fields where a competing candidate scored almost as well. */
  ambiguousFields: InvoiceFieldName[];
  extractions: Record<InvoiceFieldName, FieldExtraction<unknown>>;
  vatRate: number | null;
  reconciled: boolean;
  layout: DocumentLayout;
}

function selectedValue<T>(extraction: FieldExtraction<T>, minScore: number): T | null {
  const selected = extraction.selected;
  if (!selected || selected.score < minScore) return null;
  return selected.value;
}

/**
 * The field-mapping layer: turns ranked, rule-produced candidates into the
 * normalised invoice schema. This is the only place that decides what "null"
 * means, so extractors stay free of policy.
 */
export function mapDocumentToInvoice(
  document: OcrDocument,
  config: AppConfig,
  now: Date = new Date(),
): MappedInvoice {
  const layout = new DocumentLayout(document);
  const context: ExtractionContext = { layout, config, now };

  const quality = classifyDocument(context);

  const issuer = extractIssuer(context);
  const issuerValue = selectedValue(issuer, config.FIELD_MIN_SCORE);
  const assignee = extractAssignee(context, issuerValue);
  const invoiceDate = extractInvoiceDate(context);
  const invoiceNumber = extractInvoiceNumber(context);
  const amounts = extractAmounts(context);

  const extractions: Record<InvoiceFieldName, FieldExtraction<unknown>> = {
    issuer: issuer as FieldExtraction<unknown>,
    invoiceDate: invoiceDate as FieldExtraction<unknown>,
    invoiceNumber: invoiceNumber as FieldExtraction<unknown>,
    assignee: assignee as FieldExtraction<unknown>,
    invoiceSum: amounts.invoiceSum as FieldExtraction<unknown>,
    invoiceVat: amounts.invoiceVat as FieldExtraction<unknown>,
    invoiceSumAndVat: amounts.invoiceSumAndVat as FieldExtraction<unknown>,
  };

  const warnings: string[] = [];
  const fieldConfidence: Partial<Record<InvoiceFieldName, number>> = {};
  const ambiguousFields: InvoiceFieldName[] = [];

  const invoice: Invoice = {
    issuer: issuerValue,
    invoiceDate: selectedValue(invoiceDate, config.FIELD_MIN_SCORE),
    invoiceNumber: selectedValue(invoiceNumber, config.FIELD_MIN_SCORE),
    assignee: selectedValue(assignee, config.FIELD_MIN_SCORE),
    invoiceSum: selectedValue(amounts.invoiceSum, config.FIELD_MIN_SCORE),
    invoiceVat: selectedValue(amounts.invoiceVat, config.FIELD_MIN_SCORE),
    invoiceSumAndVat: selectedValue(amounts.invoiceSumAndVat, config.FIELD_MIN_SCORE),
    sourceFileName: document.fileName,
    warnings,
  };

  for (const [field, extraction] of Object.entries(extractions) as Array<[InvoiceFieldName, FieldExtraction<unknown>]>) {
    const selected = extraction.selected;
    const accepted = selected !== null && selected.score >= config.FIELD_MIN_SCORE;
    if (accepted && selected) {
      fieldConfidence[field] = Math.round(selected.score * 100) / 100;
      // A runner-up that scored almost as well means the document itself is
      // ambiguous; the value is still returned, but flagged for review.
      const runnerUp = extraction.alternatives[0];
      if (runnerUp && runnerUp.value !== selected.value && selected.score - runnerUp.score < 0.05) {
        ambiguousFields.push(field);
        warnings.push(
          `${FIELD_LABELS[field]} is ambiguous: "${String(selected.value)}" and "${String(runnerUp.value)}" scored almost the same`,
        );
      }
      if (selected.reasons.some((reason) => reason.startsWith('derived'))) {
        warnings.push(`${FIELD_LABELS[field]} was derived from the other amounts rather than read from the document`);
      }
    } else if (selected) {
      warnings.push(
        `${FIELD_LABELS[field]} was discarded: best candidate "${String(selected.value)}" scored ${selected.score.toFixed(
          2,
        )}, below the ${config.FIELD_MIN_SCORE} threshold`,
      );
    } else {
      warnings.push(`${FIELD_LABELS[field]} could not be found in the document`);
    }
  }

  for (const note of amounts.notes) warnings.push(note);

  const dateCandidate = invoiceDate.selected as FieldCandidate<string> | null;
  if (
    invoice.invoiceDate !== null &&
    dateCandidate &&
    dateCandidate.reasons.some((reason) => reason.startsWith('day/month order assumed'))
  ) {
    if (!ambiguousFields.includes('invoiceDate')) ambiguousFields.push('invoiceDate');
    warnings.push(
      `invoice date "${dateCandidate.raw}" is ambiguous; interpreted as ${config.DATE_ORDER} (${dateCandidate.value})`,
    );
  }

  return {
    invoice,
    quality,
    fieldConfidence,
    ambiguousFields,
    extractions,
    vatRate: amounts.vatRate,
    reconciled: amounts.reconciled,
    layout,
  };
}
