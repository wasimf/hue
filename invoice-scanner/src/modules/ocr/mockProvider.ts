import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import type { RawPage } from '../../core/types.js';
import type { OcrHealth, OcrProvider, OcrRequest } from './provider.js';

const lineSchema = z.object({
  text: z.string(),
  confidence: z.number().min(0).max(1).default(0.95),
  box: z
    .object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() })
    .optional(),
});

const pageSchema = z.object({
  width: z.number().positive().default(1000),
  height: z.number().positive().default(1400),
  lines: z.array(lineSchema),
});

const fixtureSchema = z.union([
  pageSchema,
  z.object({
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    pages: z.array(pageSchema),
  }),
]);

export type MockFixture = z.infer<typeof fixtureSchema>;

/**
 * Replays recorded OCR output from `tests/fixtures/mock-ocr/<file base name>.json`.
 *
 * This keeps the parsing, validation and export layers fully testable — and the
 * whole application runnable — without Python, models or a GPU.
 */
export class MockOcrProvider implements OcrProvider {
  readonly name = 'mock';
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async recognize(request: OcrRequest): Promise<RawPage> {
    const fixture = await this.loadFixture(request.fileName);
    const pages = 'pages' in fixture && fixture.pages ? fixture.pages : [fixture as z.infer<typeof pageSchema>];
    const page = pages[request.pageNumber - 1] ?? pages[0];
    if (!page) {
      throw new AppError('OCR_FAILED', `Mock fixture for "${request.fileName}" has no page ${request.pageNumber}`);
    }

    // Fixtures may omit geometry; lay the lines out top-to-bottom so that the
    // layout-aware extractors still have something sensible to work with.
    const lineHeight = page.height / Math.max(page.lines.length, 20);
    return {
      width: page.width,
      height: page.height,
      engine: 'mock',
      lines: page.lines.map((line, index) => ({
        text: line.text,
        confidence: line.confidence,
        box: line.box ?? {
          x0: page.width * 0.08,
          y0: index * lineHeight,
          x1: page.width * 0.92,
          y1: index * lineHeight + lineHeight * 0.7,
        },
      })),
    };
  }

  private async loadFixture(fileName: string): Promise<MockFixture> {
    const base = path.basename(fileName, path.extname(fileName));
    const candidatePaths = [
      path.join(this.directory, `${base}.json`),
      path.join(this.directory, `${fileName}.json`),
    ];

    for (const candidate of candidatePaths) {
      try {
        const parsed = fixtureSchema.safeParse(JSON.parse(await readFile(candidate, 'utf8')));
        if (!parsed.success) {
          throw new AppError('OCR_FAILED', `Mock fixture "${candidate}" is malformed`, {
            details: { issues: parsed.error.issues.slice(0, 5) },
          });
        }
        return parsed.data;
      } catch (error) {
        if (error instanceof AppError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    throw new AppError(
      'OCR_FAILED',
      `No mock OCR fixture found for "${fileName}". Expected one of: ${candidatePaths.join(', ')}`,
    );
  }

  async healthCheck(): Promise<OcrHealth> {
    return { available: true, engine: 'mock', details: { directory: this.directory } };
  }
}
