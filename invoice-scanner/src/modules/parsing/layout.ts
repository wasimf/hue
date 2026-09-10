import type { BoundingBox, DocumentPage, OcrDocument, TextLine } from '../../core/types.js';

export type Side = 'left' | 'right' | 'below' | 'above';

export interface Neighbour {
  line: TextLine;
  side: Side;
  /** Normalised centre-to-centre distance (0..~1.4). */
  distance: number;
}

export function boxCenter(box: BoundingBox): { x: number; y: number } {
  return { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
}

export function boxHeight(box: BoundingBox): number {
  return Math.abs(box.y1 - box.y0);
}

export function boxWidth(box: BoundingBox): number {
  return Math.abs(box.x1 - box.x0);
}

/**
 * Read-only view over an OCR document that answers the layout questions the
 * extractors need ("what is to the right of this label?", "what is in the top
 * fifth of page 1?") without leaking geometry maths into the rules.
 */
export class DocumentLayout {
  readonly document: OcrDocument;
  readonly lines: TextLine[];
  private readonly linesByPage = new Map<number, TextLine[]>();

  constructor(document: OcrDocument) {
    this.document = document;
    this.lines = document.pages.flatMap((page) => page.lines);
    for (const page of document.pages) {
      this.linesByPage.set(page.pageNumber, [...page.lines].sort(readingOrder));
    }
  }

  get pages(): DocumentPage[] {
    return this.document.pages;
  }

  get pageCount(): number {
    return this.document.pages.length;
  }

  pageLines(pageNumber: number): TextLine[] {
    return this.linesByPage.get(pageNumber) ?? [];
  }

  /** All lines in reading order across the whole document. */
  orderedLines(): TextLine[] {
    return this.document.pages.flatMap((page) => this.pageLines(page.pageNumber));
  }

  pageText(pageNumber: number): string {
    return this.pageLines(pageNumber)
      .map((line) => line.text)
      .join('\n');
  }

  fullText(): string {
    return this.document.pages.map((page) => this.pageText(page.pageNumber)).join('\n');
  }

  /** Lines whose vertical band overlaps `line` (i.e. the same visual row). */
  sameRow(line: TextLine, tolerance = 0.6): TextLine[] {
    const height = Math.max(boxHeight(line.normalizedBox), 0.004);
    const center = boxCenter(line.normalizedBox);
    return this.pageLines(line.pageNumber).filter((candidate) => {
      if (candidate.id === line.id) return false;
      const candidateCenter = boxCenter(candidate.normalizedBox);
      return Math.abs(candidateCenter.y - center.y) <= height * tolerance + boxHeight(candidate.normalizedBox) * 0.3;
    });
  }

  /**
   * Candidate value positions for a label line, ordered by proximity:
   * same row (either side – Hebrew labels usually sit to the right of their
   * value) followed by the lines directly underneath.
   */
  neighbours(line: TextLine, options: { rows?: number } = {}): Neighbour[] {
    const rows = options.rows ?? 2;
    const center = boxCenter(line.normalizedBox);
    const result: Neighbour[] = [];

    for (const candidate of this.sameRow(line)) {
      const candidateCenter = boxCenter(candidate.normalizedBox);
      result.push({
        line: candidate,
        side: candidateCenter.x >= center.x ? 'right' : 'left',
        distance: Math.abs(candidateCenter.x - center.x),
      });
    }

    for (const candidate of this.below(line, rows)) {
      const candidateCenter = boxCenter(candidate.normalizedBox);
      result.push({
        line: candidate,
        side: 'below',
        distance: Math.abs(candidateCenter.y - center.y) + Math.abs(candidateCenter.x - center.x) * 0.25,
      });
    }

    return result.sort((a, b) => a.distance - b.distance);
  }

  /** The next `count` lines below `line` that overlap it horizontally. */
  below(line: TextLine, count = 1): TextLine[] {
    const box = line.normalizedBox;
    const center = boxCenter(box);
    return this.pageLines(line.pageNumber)
      .filter((candidate) => {
        if (candidate.id === line.id) return false;
        const candidateCenter = boxCenter(candidate.normalizedBox);
        if (candidateCenter.y <= center.y + boxHeight(box) * 0.4) return false;
        return horizontalOverlap(box, candidate.normalizedBox) > 0.2;
      })
      .slice(0, count);
  }

  /** Lines in the top `fraction` of the given page. */
  topBand(pageNumber: number, fraction = 0.25): TextLine[] {
    return this.pageLines(pageNumber).filter((line) => boxCenter(line.normalizedBox).y <= fraction);
  }

  /** Lines in the bottom `fraction` of the given page. */
  bottomBand(pageNumber: number, fraction = 0.3): TextLine[] {
    return this.pageLines(pageNumber).filter((line) => boxCenter(line.normalizedBox).y >= 1 - fraction);
  }

  /**
   * Relative text size of a line, 0..1, compared with the largest line on its
   * page. Company headers are typically the largest text on page 1.
   */
  relativeTextSize(line: TextLine): number {
    const pageLines = this.pageLines(line.pageNumber);
    const maxHeight = pageLines.reduce((max, candidate) => Math.max(max, boxHeight(candidate.normalizedBox)), 0);
    if (maxHeight <= 0) return 0;
    return boxHeight(line.normalizedBox) / maxHeight;
  }
}

/** Fraction of the narrower box that overlaps the other horizontally. */
export function horizontalOverlap(a: BoundingBox, b: BoundingBox): number {
  const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  if (overlap <= 0) return 0;
  return overlap / Math.max(Math.min(boxWidth(a), boxWidth(b)), 1e-6);
}

/** Top-to-bottom, then left-to-right. */
export function readingOrder(a: TextLine, b: TextLine): number {
  const aCenter = boxCenter(a.normalizedBox);
  const bCenter = boxCenter(b.normalizedBox);
  const rowTolerance = Math.max(boxHeight(a.normalizedBox), boxHeight(b.normalizedBox)) * 0.5;
  if (Math.abs(aCenter.y - bCenter.y) > rowTolerance) return aCenter.y - bCenter.y;
  return aCenter.x - bCenter.x;
}
