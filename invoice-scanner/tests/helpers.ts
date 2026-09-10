import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { loadConfig, type AppConfig } from '../src/config/index.js';
import type { OcrDocument, RawPage } from '../src/core/types.js';
import { buildDocumentPage } from '../src/modules/documents/pageBuilder.js';

export const FIXTURE_DIR = path.resolve(process.cwd(), 'tests/fixtures/mock-ocr');

/** Deterministic "today" so date scoring never depends on the wall clock. */
export const NOW = new Date('2025-08-01T09:00:00Z');

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    OCR_PROVIDER: 'mock',
    MOCK_OCR_DIR: 'tests/fixtures/mock-ocr',
    UPLOAD_DIR: './tmp/test-uploads',
    PDF_TEXT_LAYER_ENABLED: 'false',
    LOG_LEVEL: 'silent',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

interface FixtureLine {
  text: string;
  confidence?: number;
  box?: { x0: number; y0: number; x1: number; y1: number };
}

interface FixturePage {
  width?: number;
  height?: number;
  lines: FixtureLine[];
}

/**
 * Builds an OcrDocument straight from a mock fixture, so parsing tests do not
 * need the HTTP layer, the OCR provider or any file on disk.
 */
export async function loadFixtureDocument(name: string, config: AppConfig): Promise<OcrDocument> {
  const raw = JSON.parse(await readFile(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')) as
    | FixturePage
    | { pages: FixturePage[] };
  const fixturePages: FixturePage[] = 'pages' in raw ? raw.pages : [raw];

  const pages = fixturePages.map((page, index) => {
    const width = page.width ?? 1000;
    const height = page.height ?? 1400;
    const lineHeight = height / Math.max(page.lines.length, 20);
    const rawPage: RawPage = {
      width,
      height,
      engine: 'mock',
      lines: page.lines.map((line, lineIndex) => ({
        text: line.text,
        confidence: line.confidence ?? 0.95,
        box: line.box ?? {
          x0: width * 0.08,
          y0: lineIndex * lineHeight,
          x1: width * 0.92,
          y1: lineIndex * lineHeight + lineHeight * 0.7,
        },
      })),
    };
    return buildDocumentPage(rawPage, index + 1, 'mock', { minConfidence: config.OCR_MIN_LINE_CONFIDENCE });
  });

  const lines = pages.flatMap((page) => page.lines);
  return {
    fileName: `${name}.pdf`,
    mimeType: 'application/pdf',
    pageCount: pages.length,
    pages,
    engine: 'mock',
    languages: ['en'],
    durationMs: 1,
    meanConfidence:
      lines.length > 0 ? lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length : 0,
    warnings: [],
  };
}

export interface PdfLine {
  text: string;
  x: number;
  /** Distance from the top of the page, in points. */
  y: number;
  size?: number;
}

/** Renders a text-only PDF used to exercise the PDF text-layer fast path. */
export async function createTextPdf(pages: PdfLine[][]): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);

  for (const lines of pages) {
    const page = document.addPage([595, 842]);
    for (const line of lines) {
      const size = line.size ?? 11;
      page.drawText(line.text, { x: line.x, y: 842 - line.y, size, font });
    }
  }

  return Buffer.from(await document.save());
}

/** A minimal, valid PDF used for "one page failed" style tests. */
export async function createBlankPdf(pageCount = 1): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) document.addPage([595, 842]);
  return Buffer.from(await document.save());
}
