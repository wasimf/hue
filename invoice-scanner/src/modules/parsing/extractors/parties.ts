import type { FieldCandidate, FieldExtraction, TextLine } from '../../../core/types.js';
import { cleanEntityName, containsHebrew, foldForMatch, normalizeLine, similarity } from '../../../utils/text.js';
import { dedupeCandidates, makeCandidate, sameText, topAlternatives, type ExtractionContext } from '../context.js';
import { findDates } from '../dates.js';
import { matchKeyword, matchesAny } from '../keywords.js';
import { boxCenter } from '../layout.js';

/** Builds a punctuation-tolerant regex for a keyword term. */
function labelPattern(term: string): RegExp {
  const escaped = [...term.trim()]
    .filter((char) => !/\s/.test(char))
    .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s"\'.\\-]*');
  return new RegExp(`${escaped}[\\s:.\\-|]*`, 'iu');
}

/** Returns the part of a line that is not the label itself. */
export function remainderAfterLabel(text: string, term: string): string {
  const line = normalizeLine(text);
  const stripped = cleanEntityName(line.replace(labelPattern(term), ' '));
  if (stripped.length >= 2) return stripped;

  const colonIndex = line.indexOf(':');
  if (colonIndex >= 0) {
    const after = cleanEntityName(line.slice(colonIndex + 1));
    if (after.length >= 2) return after;
  }
  return '';
}

/** Rejects lines that are structurally incapable of being a party name. */
function looksLikeEntityName(text: string, context: ExtractionContext): boolean {
  const line = normalizeLine(text);
  if (line.length < 2 || line.length > 90) return false;
  const letters = line.replace(/[^A-Za-z֐-׿]/g, '');
  if (letters.length < 2) return false;
  // Mostly digits -> ids, phone numbers, amounts.
  if (letters.length / line.length < 0.35) return false;
  if (findDates(line, context.config.DATE_ORDER).length > 0) return false;
  if (/^(?:www\.|https?:|[\w.+-]+@)/i.test(line)) return false;
  if (matchesAny(line, ['total', 'vat', 'subtotal', 'invoiceNumber', 'issueDate', 'otherDate'])) return false;
  return true;
}

function entityBonus(text: string): { bonus: number; reasons: string[] } {
  const reasons: string[] = [];
  let bonus = 0;
  if (matchKeyword(text, 'companySuffix')) {
    bonus += 0.22;
    reasons.push('contains a legal-entity suffix');
  }
  const words = foldForMatch(text).split(' ').filter(Boolean).length;
  if (words >= 2 && words <= 8) bonus += 0.06;
  if (/^[A-Z0-9\s.&'-]+$/.test(normalizeLine(text)) && !containsHebrew(text)) bonus += 0.04;
  return { bonus, reasons };
}

/**
 * The issuer is normally the largest text in the header of page 1, and/or the
 * name next to the business registration number.
 */
export function extractIssuer(context: ExtractionContext): FieldExtraction<string> {
  const { layout } = context;
  const candidates: FieldCandidate<string>[] = [];

  const push = (value: string, line: TextLine, base: number, source: string, reasons: string[]): void => {
    const name = cleanEntityName(value);
    if (!looksLikeEntityName(name, context)) return;
    const { bonus, reasons: bonusReasons } = entityBonus(name);
    candidates.push(
      makeCandidate({
        value: name,
        raw: line.text,
        score: base + bonus + (line.confidence - 0.8) * 0.2,
        source,
        line,
        reasons: [...reasons, ...bonusReasons],
      }),
    );
  };

  // 1) Explicit "issued by"/"supplier" labels.
  for (const line of layout.orderedLines()) {
    const label = matchKeyword(line.text, 'issuer');
    if (!label) continue;
    const remainder = remainderAfterLabel(line.text, label.term);
    if (remainder) {
      push(remainder, line, 0.62, 'issuer:labelled', [`matched label "${label.term}"`]);
      continue;
    }
    const neighbour = layout.neighbours(line, { rows: 1 })[0];
    if (neighbour) {
      push(neighbour.line.text, neighbour.line, 0.55, `issuer:${neighbour.side}`, [
        `label "${label.term}" with the value ${neighbour.side} of it`,
      ]);
    }
  }

  // 2) Header block of page 1.
  for (const line of layout.topBand(1, 0.3)) {
    if (matchKeyword(line.text, 'billTo')) continue;
    const documentTitle = matchKeyword(line.text, 'invoiceDocument');
    if (documentTitle?.isLabelOnly) continue;
    const size = layout.relativeTextSize(line);
    const y = boxCenter(line.normalizedBox).y;
    push(line.text, line, 0.34 + size * 0.22 + (y <= 0.15 ? 0.08 : 0), 'issuer:header', [
      `header line on page 1 (relative text size ${size.toFixed(2)})`,
    ]);
  }

  // 3) The line carrying the business registration number, and the one above it.
  for (const line of layout.pageLines(1)) {
    if (!matchKeyword(line.text, 'companyId')) continue;
    if (boxCenter(line.normalizedBox).y > 0.45) continue;
    const label = matchKeyword(line.text, 'companyId');
    const remainder = label ? remainderAfterLabel(line.text, label.term) : '';
    if (remainder) push(remainder, line, 0.4, 'issuer:companyId', ['name shares a line with the company id']);
    const above = layout
      .pageLines(1)
      .filter((candidate) => boxCenter(candidate.normalizedBox).y < boxCenter(line.normalizedBox).y)
      .pop();
    if (above) push(above.text, above, 0.44, 'issuer:aboveCompanyId', ['line directly above the company id']);
  }

  const ranked = dedupeCandidates(candidates, sameText).sort((a, b) => b.score - a.score);
  // The mapper applies the score threshold; extractors only rank.
  const selected = ranked[0] ?? null;
  return { field: 'issuer', selected, alternatives: topAlternatives(ranked, selected) };
}

/**
 * The assignee (bill-to party) is anchored on an explicit label; without one
 * we do not guess, because guessing here silently swaps the two parties.
 */
export function extractAssignee(context: ExtractionContext, issuer: string | null): FieldExtraction<string> {
  const { layout } = context;
  const candidates: FieldCandidate<string>[] = [];

  const push = (value: string, line: TextLine, base: number, source: string, reasons: string[]): void => {
    const name = cleanEntityName(value);
    if (!looksLikeEntityName(name, context)) return;
    const { bonus, reasons: bonusReasons } = entityBonus(name);
    const issuerPenalty = issuer && similarity(issuer, name) > 0.85 ? 0.5 : 0;
    const allReasons = [...reasons, ...bonusReasons];
    if (issuerPenalty > 0) allReasons.push('down-ranked: identical to the detected issuer');
    candidates.push(
      makeCandidate({
        value: name,
        raw: line.text,
        score: base + bonus + (line.confidence - 0.8) * 0.2 - issuerPenalty,
        source,
        line,
        reasons: allReasons,
      }),
    );
  };

  for (const line of layout.orderedLines()) {
    const label = matchKeyword(line.text, 'billTo');
    if (!label) continue;

    const remainder = remainderAfterLabel(line.text, label.term);
    if (remainder) {
      push(remainder, line, 0.68, 'assignee:labelled', [`matched label "${label.term}"`]);
      continue;
    }

    // Label-only cell: the customer block usually starts right below it, but
    // in RTL layouts it often sits on the same row instead.
    for (const neighbour of layout.neighbours(line, { rows: 2 }).slice(0, 4)) {
      if (matchesAny(neighbour.line.text, ['billTo', 'issuer', 'invoiceNumber', 'issueDate'])) continue;
      const before = candidates.length;
      push(
        neighbour.line.text,
        neighbour.line,
        0.64 - Math.min(0.18, neighbour.distance * 0.3),
        `assignee:${neighbour.side}`,
        [`label "${label.term}" with the value ${neighbour.side} of it`],
      );
      if (candidates.length > before) break;
    }
  }

  const ranked = dedupeCandidates(candidates, sameText).sort((a, b) => b.score - a.score);
  // The mapper applies the score threshold; extractors only rank.
  const selected = ranked[0] ?? null;
  return { field: 'assignee', selected, alternatives: topAlternatives(ranked, selected) };
}
