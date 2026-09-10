import type { FieldCandidate, FieldExtraction, TextLine } from '../../../core/types.js';
import { dedupeCandidates, makeCandidate, topAlternatives, type ExtractionContext } from '../context.js';
import { findDates, type DateMatch } from '../dates.js';
import { foldForMatch } from '../../../utils/text.js';
import { matchKeyword } from '../keywords.js';
import { boxCenter } from '../layout.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function ageAdjustment(iso: string, now: Date): { adjustment: number; reason: string | null } {
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return { adjustment: -0.2, reason: 'unparseable date' };
  const deltaDays = (parsed - now.getTime()) / DAY_MS;
  if (deltaDays > 3) return { adjustment: -0.3, reason: 'date is in the future' };
  if (deltaDays < -365 * 6) return { adjustment: -0.15, reason: 'date is more than six years old' };
  if (deltaDays <= 0 && deltaDays > -365 * 2) return { adjustment: 0.08, reason: 'recent date' };
  return { adjustment: 0, reason: null };
}

/**
 * Extracts the invoice issue date, deliberately down-ranking due dates,
 * delivery dates and service periods.
 */
export function extractInvoiceDate(context: ExtractionContext): FieldExtraction<string> {
  const { layout, config } = context;
  const candidates: FieldCandidate<string>[] = [];

  const addMatches = (
    matches: DateMatch[],
    options: { line: TextLine; base: number; source: string; reasons: string[] },
  ): void => {
    const { line } = options;
    const y = boxCenter(line.normalizedBox).y;

    for (const match of matches) {
      const { adjustment, reason } = ageAdjustment(match.iso, context.now);
      const reasons = [...options.reasons];
      if (reason) reasons.push(reason);
      if (match.ambiguous) reasons.push(`day/month order assumed ${config.DATE_ORDER}`);
      if (match.shortYear) reasons.push('two-digit year expanded');

      candidates.push(
        makeCandidate({
          value: match.iso,
          raw: match.raw,
          score:
            options.base +
            adjustment +
            (line.pageNumber === 1 ? 0.08 : 0) +
            (y <= 0.45 ? 0.06 : 0) +
            (line.confidence - 0.8) * 0.2 -
            (match.ambiguous ? 0.12 : 0) -
            (match.shortYear ? 0.06 : 0),
          source: options.source,
          line,
          reasons,
        }),
      );
    }
  };

  for (const line of layout.orderedLines()) {
    const issueLabel = matchKeyword(line.text, 'issueDate');
    const otherLabel = matchKeyword(line.text, 'otherDate');
    const matches = findDates(line.text, config.DATE_ORDER);

    if (matches.length > 0) {
      // A line carrying both kinds of label: whichever label sits closer to the
      // date wins (common in "Date: 01/02/25   Due: 01/03/25" rows).
      const dateIndex = matches[0]?.index ?? 0;
      const issueEnd = issueLabel ? issueLabel.index + foldForMatch(issueLabel.term).length : null;
      const otherEnd = otherLabel ? otherLabel.index + foldForMatch(otherLabel.term).length : null;
      // "Due date" contains "date": a generic issue-date match nested inside a
      // due/delivery-date label must never be treated as the issue date.
      const issueNestedInOther =
        issueLabel !== null &&
        otherLabel !== null &&
        issueLabel.index >= otherLabel.index &&
        (issueEnd ?? 0) <= (otherEnd ?? 0);
      const issueDistance =
        issueEnd === null || issueNestedInOther ? Number.POSITIVE_INFINITY : Math.abs(issueEnd - dateIndex);
      const otherDistance = otherEnd === null ? Number.POSITIVE_INFINITY : Math.abs(otherEnd - dateIndex);
      const dominatedByOther = otherLabel !== null && otherDistance <= issueDistance;

      let base = 0.42;
      const reasons: string[] = [];
      if (issueLabel && !dominatedByOther) {
        base += 0.32;
        reasons.push(`matched date label "${issueLabel.term}"`);
      }
      if (dominatedByOther) {
        base -= 0.45;
        reasons.push(`down-ranked: line matches "${otherLabel?.term}"`);
      }

      addMatches(matches, { line, base, source: 'date:inline', reasons });
      continue;
    }

    // Label-only cell: the date is in a neighbouring cell.
    if (issueLabel?.isLabelOnly) {
      for (const neighbour of layout.neighbours(line, { rows: 1 }).slice(0, 4)) {
        const neighbourMatches = findDates(neighbour.line.text, config.DATE_ORDER);
        if (neighbourMatches.length === 0) continue;
        if (matchKeyword(neighbour.line.text, 'otherDate')) continue;
        addMatches(neighbourMatches, {
          line: neighbour.line,
          base: 0.62 - Math.min(0.2, neighbour.distance * 0.3),
          source: `date:${neighbour.side}`,
          reasons: [`label "${issueLabel.term}" with the date ${neighbour.side} of it`],
        });
        break;
      }
    }
  }

  const ranked = dedupeCandidates(candidates).sort((a, b) => b.score - a.score);
  // The mapper applies the score threshold; extractors only rank.
  const selected = ranked[0] ?? null;
  return { field: 'invoiceDate', selected, alternatives: topAlternatives(ranked, selected) };
}
