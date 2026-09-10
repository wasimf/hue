import type { FieldCandidate, FieldExtraction, TextLine } from '../../../core/types.js';
import { normalizeLine } from '../../../utils/text.js';
import { dedupeCandidates, makeCandidate, topAlternatives, type ExtractionContext } from '../context.js';
import { findDates, type DateOrder } from '../dates.js';
import { matchKeyword } from '../keywords.js';
import { boxCenter } from '../layout.js';

/** Tokens that look like a document reference. */
const REFERENCE_TOKEN = /(?:^|[\s:#|/\\(-])((?:[A-Za-z]{1,4}[-/ ]?)?\d[\d]{1,}(?:[-/][A-Za-z0-9]{1,8})*)/g;

interface TokenCandidate {
  value: string;
  index: number;
}

function findReferenceTokens(text: string, order: DateOrder): TokenCandidate[] {
  const line = normalizeLine(text);
  // Dates share the shape of a reference ("14/03/2025"), so their spans are
  // excluded up front rather than filtered out per candidate.
  const dateSpans = findDates(line, order).map((match) => ({
    start: match.index,
    end: match.index + match.raw.length,
  }));

  const tokens: TokenCandidate[] = [];
  for (const match of line.matchAll(REFERENCE_TOKEN)) {
    const value = (match[1] ?? '').trim();
    if (!value) continue;
    const index = (match.index ?? 0) + (match[0]?.indexOf(value) ?? 0);
    const insideDate = dateSpans.some((span) => index < span.end && index + value.length > span.start);
    if (insideDate) continue;
    tokens.push({ value, index });
  }
  return tokens;
}

function isPlausibleInvoiceNumber(token: string, context: ExtractionContext): boolean {
  const digits = token.replace(/\D/g, '');
  if (digits.length < 2 || digits.length > 16) return false;
  if (token.length > 24) return false;
  // Dates, amounts and percentages are not invoice numbers.
  if (findDates(token, context.config.DATE_ORDER).length > 0) return false;
  if (/\d[.,]\d{2}$/.test(token)) return false;
  // A bare four-digit year on its own is almost never the invoice number.
  if (/^(19|20)\d{2}$/.test(token)) return false;
  return true;
}

function penaltiesForLine(line: TextLine): { penalty: number; reasons: string[] } {
  const reasons: string[] = [];
  let penalty = 0;
  if (matchKeyword(line.text, 'companyId')) {
    penalty += 0.3;
    reasons.push('down-ranked: line also carries a company/VAT id');
  }
  if (/(?:tel|fax|phone|mobile|טלפון|פקס|נייד)/i.test(line.text)) {
    penalty += 0.35;
    reasons.push('down-ranked: line looks like contact details');
  }
  if (/(?:iban|swift|account|חשבון בנק|בנק|סניף)/i.test(line.text)) {
    penalty += 0.3;
    reasons.push('down-ranked: line looks like bank details');
  }
  return { penalty, reasons };
}

/** Extracts the invoice/document number. */
export function extractInvoiceNumber(context: ExtractionContext): FieldExtraction<string> {
  const { layout } = context;
  const candidates: FieldCandidate<string>[] = [];

  const push = (
    value: string,
    line: TextLine,
    base: number,
    source: string,
    reasons: string[],
    labelIndex: number | null,
    tokenIndex: number,
  ): void => {
    if (!isPlausibleInvoiceNumber(value, context)) return;
    const { penalty, reasons: penaltyReasons } = penaltiesForLine(line);
    const proximity = labelIndex === null ? 0 : Math.max(0, 0.12 - Math.abs(tokenIndex - labelIndex) / 400);
    const digits = value.replace(/\D/g, '').length;
    candidates.push(
      makeCandidate({
        value: value.replace(/\s+/g, ''),
        raw: line.text,
        score:
          base +
          proximity +
          (line.pageNumber === 1 ? 0.06 : 0) +
          (boxCenter(line.normalizedBox).y <= 0.5 ? 0.05 : 0) +
          (digits >= 3 && digits <= 12 ? 0.06 : 0) +
          (line.confidence - 0.8) * 0.2 -
          penalty,
        source,
        line,
        reasons: [...reasons, ...penaltyReasons],
      }),
    );
  };

  for (const line of layout.orderedLines()) {
    const numberLabel = matchKeyword(line.text, 'invoiceNumber');
    const documentLabel = matchKeyword(line.text, 'invoiceDocument');
    const tokens = findReferenceTokens(line.text, context.config.DATE_ORDER);

    if (numberLabel && tokens.length > 0) {
      for (const token of tokens) {
        push(token.value, line, 0.66, 'invoiceNumber:labelled', [`matched label "${numberLabel.term}"`], numberLabel.index, token.index);
      }
      continue;
    }

    if (documentLabel && tokens.length > 0) {
      for (const token of tokens) {
        push(
          token.value,
          line,
          0.52,
          'invoiceNumber:documentTitle',
          [`number found on the "${documentLabel.term}" title line`],
          documentLabel.index,
          token.index,
        );
      }
      continue;
    }

    if (numberLabel?.isLabelOnly) {
      for (const neighbour of layout.neighbours(line, { rows: 1 }).slice(0, 4)) {
        const neighbourTokens = findReferenceTokens(neighbour.line.text, context.config.DATE_ORDER);
        if (neighbourTokens.length === 0) continue;
        const first = neighbourTokens[0] as TokenCandidate;
        push(
          first.value,
          neighbour.line,
          0.6 - Math.min(0.2, neighbour.distance * 0.3),
          `invoiceNumber:${neighbour.side}`,
          [`label "${numberLabel.term}" with the value ${neighbour.side} of it`],
          null,
          first.index,
        );
        break;
      }
      continue;
    }

    // `#1234` is a strong enough signal on its own.
    for (const match of normalizeLine(line.text).matchAll(/#\s*([A-Za-z0-9][A-Za-z0-9\-/]{1,20})/g)) {
      push(match[1] as string, line, 0.5, 'invoiceNumber:hash', ['value followed a "#" marker'], null, match.index ?? 0);
    }
  }

  const ranked = dedupeCandidates(candidates).sort((a, b) => b.score - a.score);
  // The mapper applies the score threshold; extractors only rank.
  const selected = ranked[0] ?? null;
  return { field: 'invoiceNumber', selected, alternatives: topAlternatives(ranked, selected) };
}
