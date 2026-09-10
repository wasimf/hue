import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { AppError } from '../../core/errors.js';
import type { SupportedMimeType } from '../../core/types.js';

const SUPPORTED: Record<string, SupportedMimeType> = {
  'application/pdf': 'application/pdf',
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
};

const BY_EXTENSION: Record<string, SupportedMimeType> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export const SUPPORTED_EXTENSIONS = Object.keys(BY_EXTENSION);

/**
 * Resolves the real type of an upload from its magic bytes, falling back to
 * the file extension. The declared multipart mimetype is never trusted.
 */
export async function detectMimeType(buffer: Buffer, fileName: string): Promise<SupportedMimeType> {
  const sniffed = await fileTypeFromBuffer(buffer);
  if (sniffed && SUPPORTED[sniffed.mime]) return SUPPORTED[sniffed.mime] as SupportedMimeType;

  const extension = path.extname(fileName).toLowerCase();
  const byExtension = BY_EXTENSION[extension];
  if (byExtension && !sniffed) return byExtension;

  throw new AppError(
    'UNSUPPORTED_FILE_TYPE',
    `Unsupported file type for "${fileName}". Supported types: PDF, PNG, JPG/JPEG.`,
    { details: { detected: sniffed?.mime ?? null, extension } },
  );
}

export function isSupportedExtension(fileName: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(path.extname(fileName).toLowerCase());
}
