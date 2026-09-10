import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/index.js';
import { newId } from '../../utils/id.js';

export interface StoredUpload {
  /** Original (sanitised) file name as supplied by the client. */
  fileName: string;
  /** Absolute path of the temporary copy on disk. */
  path: string;
  buffer: Buffer;
  byteSize: number;
}

/** Strips directory components and control characters from a client file name. */
export function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName ?? '').replace(/[\u0000-\u001f\u007f]/g, '');
  const cleaned = base.replace(/[\\/:*?"<>|]/g, '_').trim();
  return (cleaned || 'upload').slice(0, 180);
}

/**
 * Temporary storage for uploads.
 *
 * Files are written to disk (so large batches are not pinned in memory by
 * anything other than the active worker) and removed once the batch completes,
 * unless `KEEP_UPLOADS` is enabled for debugging.
 */
export class UploadStore {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.config.uploadDirAbsolute, { recursive: true });
  }

  async persist(fileName: string, buffer: Buffer): Promise<StoredUpload> {
    const safeName = sanitizeFileName(fileName);
    const target = path.join(this.config.uploadDirAbsolute, `${newId('upl')}-${safeName}`);
    await writeFile(target, buffer);
    return { fileName: safeName, path: target, buffer, byteSize: buffer.byteLength };
  }

  async cleanup(uploads: readonly StoredUpload[]): Promise<void> {
    if (this.config.KEEP_UPLOADS) {
      this.logger.debug({ count: uploads.length }, 'KEEP_UPLOADS is enabled, temporary files were left in place');
      return;
    }
    await Promise.all(
      uploads.map(async (upload) => {
        try {
          await rm(upload.path, { force: true });
        } catch (error) {
          this.logger.warn({ err: error, path: upload.path }, 'failed to remove temporary upload');
        }
      }),
    );
  }
}
