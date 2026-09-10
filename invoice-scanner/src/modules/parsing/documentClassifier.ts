import type { DocumentQuality } from '../../core/types.js';
import { containsHebrew, containsLatin, noiseRatio } from '../../utils/text.js';
import type { ExtractionContext } from './context.js';
import { collectCategories, matchKeyword } from './keywords.js';
import { extractNumericTokens } from './number.js';

const SIGNALS: Array<{ category: Parameters<typeof matchKeyword>[1]; weight: number }> = [
  { category: 'invoiceDocument', weight: 0.34 },
  { category: 'total', weight: 0.18 },
  { category: 'vat', weight: 0.16 },
  { category: 'invoiceNumber', weight: 0.14 },
  { category: 'issueDate', weight: 0.1 },
  { category: 'billTo', weight: 0.08 },
  { category: 'companyId', weight: 0.06 },
];

/**
 * Decides whether the document is an invoice at all, and whether the OCR
 * result is good enough to trust. Cheap keyword + quality signals only – this
 * runs before field extraction so obviously wrong inputs are flagged early.
 */
export function classifyDocument(context: ExtractionContext): DocumentQuality {
  const { layout, config } = context;
  const fullText = layout.fullText();
  const totalCharacters = fullText.replace(/\s/g, '').length;

  const lineConfidences = layout.lines.map((line) => line.confidence);
  const meanOcrConfidence =
    lineConfidences.length > 0 ? lineConfidences.reduce((sum, value) => sum + value, 0) / lineConfidences.length : 0;

  const matchedKeywords: string[] = [];
  let invoiceScore = 0;
  for (const signal of SIGNALS) {
    const match = matchKeyword(fullText, signal.category);
    if (match) {
      invoiceScore += signal.weight;
      matchedKeywords.push(match.term);
    }
  }

  const nonInvoice = matchKeyword(fullText, 'nonInvoice');
  if (nonInvoice) {
    invoiceScore -= 0.35;
    matchedKeywords.push(`!${nonInvoice.term}`);
  }

  const hasAmounts = layout.lines.some((line) =>
    extractNumericTokens(line.text).some((token) => token.decimals === 2 || token.hasCurrencySymbol),
  );
  if (hasAmounts) invoiceScore += 0.1;

  const noise = noiseRatio(fullText);
  if (noise > 0.35) invoiceScore -= 0.1;

  invoiceScore = Math.min(1, Math.max(0, invoiceScore));

  const detectedLanguages = [
    ...(containsHebrew(fullText) ? ['he'] : []),
    ...(containsLatin(fullText) ? ['en'] : []),
  ];

  let classification: DocumentQuality['classification'];
  if (totalCharacters < 25 || meanOcrConfidence < 0.3) {
    classification = 'unreadable';
  } else if (invoiceScore >= 0.6) {
    classification = 'invoice';
  } else if (invoiceScore >= config.INVOICE_MIN_DOCUMENT_SCORE) {
    classification = 'probably-invoice';
  } else {
    classification = 'not-an-invoice';
  }

  // Categories are collected for observability/debugging of new templates.
  const allCategories = collectCategories(fullText);

  return {
    classification,
    invoiceScore: Math.round(invoiceScore * 100) / 100,
    meanOcrConfidence: Math.round(meanOcrConfidence * 1000) / 1000,
    totalCharacters,
    matchedKeywords: [...new Set([...matchedKeywords, ...allCategories.map((category) => `#${category}`)])],
    detectedLanguages,
  };
}
