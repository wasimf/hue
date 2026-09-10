import type { FieldCandidate, FieldExtraction, TextLine } from '../../../core/types.js';
import { foldForMatch } from '../../../utils/text.js';
import { clampScore, dedupeCandidates, makeCandidate, topAlternatives, type ExtractionContext } from '../context.js';
import { matchKeyword, type KeywordCategory } from '../keywords.js';
import { boxCenter } from '../layout.js';
import { amountsMatch, extractNumericTokens, roundMoney, type NumericToken } from '../number.js';

export type AmountRole = 'net' | 'vat' | 'gross';

const ROLE_BY_CATEGORY: Record<'subtotal' | 'vat' | 'total', AmountRole> = {
  subtotal: 'net',
  vat: 'vat',
  total: 'gross',
};

export interface AmountExtraction {
  invoiceSum: FieldExtraction<number>;
  invoiceVat: FieldExtraction<number>;
  invoiceSumAndVat: FieldExtraction<number>;
  /** VAT rate implied by the selected amounts, in percent. */
  vatRate: number | null;
  /** True when sum + vat == total held for the selected combination. */
  reconciled: boolean;
  notes: string[];
}

interface RoleCandidate {
  role: AmountRole;
  candidate: FieldCandidate<number>;
}

/**
 * Decides which keyword category a line belongs to. The longest matching term
 * wins, so "total including VAT" is a gross total rather than a VAT amount.
 */
function classifyLine(text: string): { role: AmountRole; term: string; labelOnly: boolean; specificity: number } | null {
  const categories: Array<'subtotal' | 'vat' | 'total'> = ['subtotal', 'vat', 'total'];
  let best: { category: KeywordCategory; term: string; labelOnly: boolean } | null = null;
  let bestLength = 0;

  for (const category of categories) {
    const match = matchKeyword(text, category);
    if (!match) continue;
    const length = foldForMatch(match.term).length;
    if (length > bestLength) {
      bestLength = length;
      best = { category, term: match.term, labelOnly: match.isLabelOnly };
    }
  }

  if (!best) return null;
  return {
    role: ROLE_BY_CATEGORY[best.category as 'subtotal' | 'vat' | 'total'],
    term: best.term,
    labelOnly: best.labelOnly,
    // Longer, more explicit labels ("total including VAT") are more reliable.
    specificity: clampScore(bestLength / 18),
  };
}

/** Picks the token on a line that most plausibly carries the amount. */
function pickAmountToken(tokens: NumericToken[]): NumericToken | null {
  const usable = tokens.filter((token) => !token.isPercent);
  if (usable.length === 0) return null;
  const scored = usable.map((token) => {
    let score = 0;
    if (token.decimals === 2) score += 3;
    else if (token.decimals > 0) score += 1;
    if (token.hasCurrencySymbol) score += 2;
    if (Math.abs(token.value) >= 1) score += 1;
    // A bare small integer next to a label is usually a rate or a line number.
    if (token.decimals === 0 && Math.abs(token.value) < 100) score -= 1;
    // Later tokens on the line tend to be the value rather than the label.
    score += token.index / 1000;
    return { token, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.token ?? null;
}

function tokenQuality(token: NumericToken): number {
  let quality = 0;
  if (token.decimals === 2) quality += 0.18;
  if (token.hasCurrencySymbol) quality += 0.08;
  if (Math.abs(token.value) >= 1) quality += 0.04;
  return quality;
}

/** Amounts that sit on a labelled line, or next to a label-only line. */
function collectLabelledAmounts(context: ExtractionContext): RoleCandidate[] {
  const { layout } = context;
  const results: RoleCandidate[] = [];

  for (const line of layout.orderedLines()) {
    const classification = classifyLine(line.text);
    if (!classification) continue;

    const isLastPage = line.pageNumber === layout.pageCount;
    const verticalPosition = boxCenter(line.normalizedBox).y;
    const tokens = extractNumericTokens(line.text);
    const inlineToken = pickAmountToken(tokens);

    const positionBonus = isLastPage && verticalPosition > 0.5 ? 0.06 : 0;
    const confidenceBonus = (line.confidence - 0.8) * 0.2;

    if (inlineToken) {
      results.push({
        role: classification.role,
        candidate: makeCandidate({
          value: roundMoney(inlineToken.value),
          raw: line.text,
          score: 0.6 + classification.specificity * 0.2 + tokenQuality(inlineToken) + positionBonus + confidenceBonus,
          source: `amount:inline:${classification.role}`,
          line,
          reasons: [`matched label "${classification.term}" on the same line`],
        }),
      });
      continue;
    }

    // Label-only line: the value lives in a neighbouring cell.
    for (const neighbour of layout.neighbours(line, { rows: 1 }).slice(0, 4)) {
      const neighbourTokens = extractNumericTokens(neighbour.line.text);
      // Skip neighbours that are themselves labels of another amount.
      if (classifyLine(neighbour.line.text)) continue;
      const token = pickAmountToken(neighbourTokens);
      if (!token) continue;
      const distancePenalty = Math.min(0.25, neighbour.distance * 0.35);
      results.push({
        role: classification.role,
        candidate: makeCandidate({
          value: roundMoney(token.value),
          raw: `${line.text} -> ${neighbour.line.text}`,
          score:
            0.52 + classification.specificity * 0.2 + tokenQuality(token) + positionBonus + confidenceBonus - distancePenalty,
          source: `amount:${neighbour.side}:${classification.role}`,
          line: neighbour.line,
          reasons: [`label "${classification.term}" with the value ${neighbour.side} of it`],
        }),
      });
      break;
    }
  }

  return results;
}

/**
 * Unlabelled amounts near the bottom of the document. These are weak
 * candidates that only win when reconciliation proves them consistent.
 */
function collectLooseAmounts(context: ExtractionContext): FieldCandidate<number>[] {
  const { layout } = context;
  const lastPage = layout.pageCount;
  const candidates: FieldCandidate<number>[] = [];

  const consider = (line: TextLine): void => {
    for (const token of extractNumericTokens(line.text)) {
      if (token.isPercent || token.decimals !== 2 || Math.abs(token.value) < 1) continue;
      candidates.push(
        makeCandidate({
          value: roundMoney(token.value),
          raw: line.text,
          score: 0.22 + tokenQuality(token) * 0.5,
          source: 'amount:loose',
          line,
          reasons: ['unlabelled amount used only for arithmetic reconciliation'],
        }),
      );
    }
  };

  for (const line of layout.bottomBand(lastPage, 0.45)) consider(line);
  return dedupeCandidates(candidates);
}

interface Combination {
  net: FieldCandidate<number> | null;
  vat: FieldCandidate<number> | null;
  gross: FieldCandidate<number> | null;
  score: number;
  reconciled: boolean;
  vatRate: number | null;
}

function evaluateCombination(
  net: FieldCandidate<number> | null,
  vat: FieldCandidate<number> | null,
  gross: FieldCandidate<number> | null,
  context: ExtractionContext,
): Combination {
  const tolerance = {
    absolute: context.config.AMOUNT_TOLERANCE_ABS,
    relative: context.config.AMOUNT_TOLERANCE_REL,
  };

  let score = (net?.score ?? 0) + (vat?.score ?? 0) + (gross?.score ?? 0);
  score += [net, vat, gross].filter(Boolean).length * 0.15;

  let reconciled = false;
  let vatRate: number | null = null;

  if (net && vat && gross) {
    if (amountsMatch(net.value + vat.value, gross.value, tolerance)) {
      score += 1.5;
      reconciled = true;
    } else {
      score -= 0.9;
    }
  }

  if (net && gross && net.value > gross.value) score -= 0.5;
  if (vat && gross && Math.abs(vat.value) > Math.abs(gross.value)) score -= 0.6;

  const rateBase = net?.value ?? (gross && vat ? gross.value - vat.value : null);
  if (vat && rateBase && rateBase !== 0) {
    const rate = (vat.value / rateBase) * 100;
    vatRate = Math.round(rate * 100) / 100;
    if (context.config.EXPECTED_VAT_RATES.some((expected) => Math.abs(rate - expected) <= 0.6)) {
      score += 0.5;
    } else if (rate < 0 || rate > 30) {
      score -= 0.4;
    }
  }

  return { net, vat, gross, score, reconciled, vatRate };
}

function bestOf(candidates: FieldCandidate<number>[], limit: number): Array<FieldCandidate<number> | null> {
  return [...candidates.slice(0, limit), null];
}

/**
 * Extracts the three monetary fields together, because they constrain each
 * other: `net + vat = gross` is the single strongest signal available and is
 * used to choose between competing OCR candidates, not merely to validate them.
 */
export function extractAmounts(context: ExtractionContext): AmountExtraction {
  const labelled = collectLabelledAmounts(context);
  const loose = collectLooseAmounts(context);
  const notes: string[] = [];

  const byRole = (role: AmountRole): FieldCandidate<number>[] =>
    dedupeCandidates(
      labelled.filter((entry) => entry.role === role).map((entry) => entry.candidate),
      (a, b) => Math.abs(a - b) < 0.005,
    ).sort((a, b) => b.score - a.score);

  const netCandidates = byRole('net');
  const vatCandidates = byRole('vat');
  const grossCandidates = byRole('gross');

  // Loose amounts can stand in for a missing gross/net when they reconcile.
  const grossPool = dedupeCandidates([...grossCandidates, ...loose], (a, b) => Math.abs(a - b) < 0.005).sort(
    (a, b) => b.score - a.score,
  );
  const netPool = dedupeCandidates([...netCandidates, ...loose], (a, b) => Math.abs(a - b) < 0.005).sort(
    (a, b) => b.score - a.score,
  );

  let best: Combination | null = null;
  for (const net of bestOf(netPool, 4)) {
    for (const vat of bestOf(vatCandidates, 4)) {
      for (const gross of bestOf(grossPool, 4)) {
        if (net && gross && net.value === gross.value && vat) continue;
        const combination = evaluateCombination(net, vat, gross, context);
        if (!best || combination.score > best.score) best = combination;
      }
    }
  }

  let { net, vat, gross } = best ?? { net: null, vat: null, gross: null };
  const reconciled = best?.reconciled ?? false;
  let vatRate = best?.vatRate ?? null;

  // Derive the single missing value when the other two are known.
  const derive = (value: number, from: string): FieldCandidate<number> =>
    makeCandidate({
      value: roundMoney(value),
      raw: from,
      score: 0.55,
      source: 'amount:derived',
      pageNumber: context.layout.pageCount,
      reasons: [from],
    });

  // Only derive from values that will themselves survive the mapper's score
  // threshold: a figure computed from a discarded one is worse than a null,
  // because it looks like it was read off the document.
  const trusted = (candidate: FieldCandidate<number> | null): candidate is FieldCandidate<number> =>
    candidate !== null && candidate.score >= context.config.FIELD_MIN_SCORE;

  if (trusted(net) && trusted(vat) && !gross) {
    gross = derive(net.value + vat.value, 'derived from invoice sum + VAT');
    notes.push('invoiceSumAndVat was derived from invoiceSum + invoiceVat');
  } else if (trusted(gross) && trusted(vat) && !net) {
    net = derive(gross.value - vat.value, 'derived from total - VAT');
    notes.push('invoiceSum was derived from invoiceSumAndVat - invoiceVat');
  } else if (trusted(gross) && trusted(net) && !vat) {
    vat = derive(gross.value - net.value, 'derived from total - invoice sum');
    notes.push('invoiceVat was derived from invoiceSumAndVat - invoiceSum');
  }

  if (vat && net && net.value !== 0) {
    vatRate = Math.round((vat.value / net.value) * 10000) / 100;
  }

  return {
    invoiceSum: { field: 'invoiceSum', selected: net, alternatives: topAlternatives(netPool, net) },
    invoiceVat: { field: 'invoiceVat', selected: vat, alternatives: topAlternatives(vatCandidates, vat) },
    invoiceSumAndVat: { field: 'invoiceSumAndVat', selected: gross, alternatives: topAlternatives(grossPool, gross) },
    vatRate,
    reconciled,
    notes,
  };
}
