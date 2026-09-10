import { createRequire } from 'node:module';
import path from 'node:path';
import { AppError } from '../../core/errors.js';
import type { BoundingBox, RawPage, RawTextLine } from '../../core/types.js';

/**
 * Digital-born PDFs already contain their text. Reading that layer is orders of
 * magnitude faster and more accurate than OCR, so it is tried first; scanned
 * PDFs simply yield too little text and fall back to PaddleOCR.
 */

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/**
 * Location of the fonts pdfjs falls back to for non-embedded standard fonts.
 * Without it pdfjs logs a warning on every document.
 */
const standardFontDataUrl = (): string | undefined => {
  try {
    const require = createRequire(import.meta.url);
    return `${path.dirname(require.resolve('pdfjs-dist/package.json'))}${path.sep}standard_fonts${path.sep}`;
  } catch {
    return undefined;
  }
};

async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsPromise;
}

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

/** Groups text items that share a baseline into visual lines. */
function groupIntoLines(items: TextItemLike[], pageHeight: number): RawTextLine[] {
  const positioned = items
    .filter((item) => item.str && item.str.trim().length > 0)
    .map((item) => {
      const x = item.transform[4] ?? 0;
      const baseline = item.transform[5] ?? 0;
      const height = Math.abs(item.height) || Math.abs(item.transform[3] ?? 10) || 10;
      const width = Math.abs(item.width) || item.str.length * height * 0.5;
      // PDF user space has its origin at the bottom-left; flip to top-left.
      const y0 = pageHeight - baseline - height;
      return { text: item.str, box: { x0: x, y0, x1: x + width, y1: y0 + height } satisfies BoundingBox, height };
    })
    .sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);

  const lines: RawTextLine[] = [];
  let current: { parts: typeof positioned; box: BoundingBox } | null = null;

  /**
   * Emits a row as one or more lines. A wide horizontal gap means separate
   * cells (a header block and a document title, a label and its value), which
   * the layout-aware extractors rely on being distinct.
   */
  const flush = (): void => {
    if (!current) return;
    const ordered = [...current.parts].sort((a, b) => a.box.x0 - b.box.x0);

    let segment: typeof ordered = [];
    const emit = (): void => {
      if (segment.length === 0) return;
      let text = '';
      let previousEnd: number | null = null;
      let box: BoundingBox | null = null;
      for (const part of segment) {
        const gap = previousEnd === null ? 0 : part.box.x0 - previousEnd;
        if (previousEnd !== null && gap > part.height * 0.25 && !text.endsWith(' ')) text += ' ';
        text += part.text;
        previousEnd = part.box.x1;
        box = box
          ? {
              x0: Math.min(box.x0, part.box.x0),
              y0: Math.min(box.y0, part.box.y0),
              x1: Math.max(box.x1, part.box.x1),
              y1: Math.max(box.y1, part.box.y1),
            }
          : { ...part.box };
      }
      const trimmed = text.replace(/\s+/g, ' ').trim();
      if (trimmed && box) lines.push({ text: trimmed, confidence: 0.99, box });
      segment = [];
    };

    let previousEnd: number | null = null;
    for (const part of ordered) {
      const gap = previousEnd === null ? 0 : part.box.x0 - previousEnd;
      if (previousEnd !== null && gap > Math.max(part.height * 2, 18)) emit();
      segment.push(part);
      previousEnd = part.box.x1;
    }
    emit();

    current = null;
  };

  for (const item of positioned) {
    if (!current) {
      current = { parts: [item], box: { ...item.box } };
      continue;
    }
    const tolerance = Math.max(item.height, 4) * 0.6;
    const currentCenter = (current.box.y0 + current.box.y1) / 2;
    const itemCenter = (item.box.y0 + item.box.y1) / 2;
    if (Math.abs(currentCenter - itemCenter) <= tolerance) {
      current.parts.push(item);
      current.box = {
        x0: Math.min(current.box.x0, item.box.x0),
        y0: Math.min(current.box.y0, item.box.y0),
        x1: Math.max(current.box.x1, item.box.x1),
        y1: Math.max(current.box.y1, item.box.y1),
      };
    } else {
      flush();
      current = { parts: [item], box: { ...item.box } };
    }
  }
  flush();

  return lines.filter((line) => line.text.length > 0);
}

export interface PdfTextLayerPage {
  pageNumber: number;
  page: RawPage;
  characterCount: number;
}

/**
 * Extracts the embedded text layer of every page.
 * Returns an empty array when the PDF has no usable text layer.
 */
export async function extractPdfTextLayer(buffer: Buffer, maxPages: number): Promise<PdfTextLayerPage[]> {
  let pdfjs: PdfjsModule;
  try {
    pdfjs = await loadPdfjs();
  } catch (error) {
    throw new AppError('DOCUMENT_LOAD_FAILED', 'pdfjs-dist could not be loaded', { cause: error });
  }

  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    // Text extraction needs no worker and no canvas, only the fallback fonts.
    useWorkerFetch: false,
    standardFontDataUrl: standardFontDataUrl(),
  });

  const results: PdfTextLayerPage[] = [];
  const document = await task.promise;
  try {
    const pageCount = Math.min(document.numPages, maxPages);
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items.filter((item) => 'str' in item) as unknown as TextItemLike[];
      const lines = groupIntoLines(items, viewport.height);
      const characterCount = lines.reduce((sum, line) => sum + line.text.replace(/\s/g, '').length, 0);
      results.push({
        pageNumber,
        characterCount,
        page: {
          width: viewport.width,
          height: viewport.height,
          lines,
          engine: 'pdf-text-layer',
        },
      });
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }

  return results;
}
