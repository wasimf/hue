import type { BoundingBox, DocumentPage, RawPage, TextLine, TextSource } from '../../core/types.js';
import { containsRtl, normalizeLine } from '../../utils/text.js';
import { readingOrder } from '../parsing/layout.js';

function normalizeBox(box: BoundingBox, width: number, height: number): BoundingBox {
  const safeWidth = width > 0 ? width : 1;
  const safeHeight = height > 0 ? height : 1;
  return {
    x0: box.x0 / safeWidth,
    y0: box.y0 / safeHeight,
    x1: box.x1 / safeWidth,
    y1: box.y1 / safeHeight,
  };
}

/**
 * Converts raw engine output into the normalised page model: text cleaned,
 * boxes normalised to 0..1, low-confidence noise dropped, reading order fixed.
 */
export function buildDocumentPage(
  raw: RawPage,
  pageNumber: number,
  source: TextSource,
  options: { minConfidence: number },
): DocumentPage {
  const warnings = [...(raw.warnings ?? [])];
  const kept: TextLine[] = [];
  let dropped = 0;

  raw.lines.forEach((line, index) => {
    const text = normalizeLine(line.text);
    if (!text) return;
    if (line.confidence < options.minConfidence) {
      dropped += 1;
      return;
    }
    kept.push({
      id: `p${pageNumber}-l${index}`,
      pageNumber,
      text,
      confidence: Number.isFinite(line.confidence) ? Math.min(1, Math.max(0, line.confidence)) : 0,
      box: line.box,
      normalizedBox: normalizeBox(line.box, raw.width, raw.height),
      rtl: containsRtl(text),
    });
  });

  if (dropped > 0) {
    warnings.push(`${dropped} low-confidence text line(s) were dropped on page ${pageNumber}`);
  }

  const lines = kept.sort(readingOrder);
  const meanConfidence =
    lines.length > 0 ? lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length : 0;

  return {
    pageNumber,
    width: raw.width,
    height: raw.height,
    source,
    lines,
    meanConfidence: Math.round(meanConfidence * 1000) / 1000,
    warnings,
  };
}
