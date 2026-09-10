import type { AppConfig } from '../../config/index.js';
import type { FieldCandidate, InvoiceFieldName, TextLine } from '../../core/types.js';
import { similarity } from '../../utils/text.js';
import type { DocumentLayout } from './layout.js';

export interface ExtractionContext {
  layout: DocumentLayout;
  config: AppConfig;
  /** Injected for deterministic tests. */
  now: Date;
}

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function makeCandidate<T>(input: {
  value: T;
  raw: string;
  score: number;
  source: string;
  line?: TextLine | null;
  pageNumber?: number;
  reasons?: string[];
}): FieldCandidate<T> {
  return {
    value: input.value,
    raw: input.raw,
    score: clampScore(input.score),
    source: input.source,
    pageNumber: input.pageNumber ?? input.line?.pageNumber ?? 1,
    lineId: input.line?.id ?? null,
    reasons: input.reasons ?? [],
  };
}

/**
 * Collapses candidates that resolve to the same value, keeping the highest
 * scoring one and merging the reasons of the duplicates.
 */
export function dedupeCandidates<T>(
  candidates: FieldCandidate<T>[],
  isSame: (a: T, b: T) => boolean = (a, b) => a === b,
): FieldCandidate<T>[] {
  const kept: FieldCandidate<T>[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.score - a.score)) {
    const existing = kept.find((entry) => isSame(entry.value, candidate.value));
    if (existing) {
      for (const reason of candidate.reasons) {
        if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      }
      continue;
    }
    kept.push(candidate);
  }
  return kept;
}

/** Text candidates are the same when they are near-identical strings. */
export function sameText(a: string, b: string): boolean {
  return similarity(a, b) >= 0.9;
}

/** Keeps the top `limit` alternatives for debug output. */
export function topAlternatives<T>(candidates: FieldCandidate<T>[], selected: FieldCandidate<T> | null, limit = 4): FieldCandidate<T>[] {
  return candidates.filter((candidate) => candidate !== selected).slice(0, limit);
}

export const FIELD_LABELS: Record<InvoiceFieldName, string> = {
  issuer: 'issuer',
  invoiceDate: 'invoice date',
  invoiceNumber: 'invoice number',
  assignee: 'assignee',
  invoiceSum: 'invoice sum (net)',
  invoiceVat: 'VAT amount',
  invoiceSumAndVat: 'invoice sum incl. VAT',
};
