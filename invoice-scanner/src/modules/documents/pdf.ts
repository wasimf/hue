import { PDFDocument } from 'pdf-lib';
import { AppError } from '../../core/errors.js';

export interface PdfPageSlice {
  pageNumber: number;
  /** A single-page PDF, ready to be handed to the OCR service. */
  bytes: Buffer;
}

/** Number of pages in a PDF, without rendering anything. */
export async function getPdfPageCount(buffer: Buffer): Promise<number> {
  try {
    const document = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
    return document.getPageCount();
  } catch (error) {
    throw new AppError('DOCUMENT_LOAD_FAILED', `The PDF could not be opened: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/**
 * Splits a PDF into single-page documents so that each page can be OCR'd
 * independently (and in parallel), and so that one broken page does not fail
 * the whole document.
 */
export async function splitPdfPages(buffer: Buffer, pageNumbers: number[]): Promise<PdfPageSlice[]> {
  let source: PDFDocument;
  try {
    source = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
  } catch (error) {
    throw new AppError('DOCUMENT_LOAD_FAILED', `The PDF could not be opened: ${(error as Error).message}`, {
      cause: error,
    });
  }

  const slices: PdfPageSlice[] = [];
  for (const pageNumber of pageNumbers) {
    const target = await PDFDocument.create();
    const [copied] = await target.copyPages(source, [pageNumber - 1]);
    if (!copied) continue;
    target.addPage(copied);
    slices.push({ pageNumber, bytes: Buffer.from(await target.save()) });
  }
  return slices;
}
