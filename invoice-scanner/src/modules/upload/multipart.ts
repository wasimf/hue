import type { MultipartFile } from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/index.js';
import { AppError } from '../../core/errors.js';
import { isSupportedExtension } from '../documents/fileTypes.js';
import type { StoredUpload, UploadStore } from './uploadStore.js';

/**
 * Reads every file part of a multipart request into temporary storage.
 *
 * Limits are enforced twice: by Fastify while streaming (so nothing oversized
 * is ever fully buffered) and here for batch-level rules, so a client cannot
 * exhaust memory or disk.
 */
export async function collectUploads(
  request: FastifyRequest,
  config: AppConfig,
  store: UploadStore,
): Promise<StoredUpload[]> {
  if (!request.isMultipart()) {
    throw new AppError('BAD_REQUEST', 'Expected a multipart/form-data request with one or more files');
  }

  const uploads: StoredUpload[] = [];

  try {
    for await (const part of request.files()) {
      if (uploads.length >= config.MAX_FILES_PER_BATCH) {
        throw new AppError('TOO_MANY_FILES', `At most ${config.MAX_FILES_PER_BATCH} files can be uploaded per batch`);
      }

      const file = part as MultipartFile;
      const buffer = await file.toBuffer();

      if (file.file.truncated) {
        throw new AppError('FILE_TOO_LARGE', `"${file.filename}" exceeds the ${config.MAX_FILE_SIZE_BYTES} byte limit`, {
          details: { fileName: file.filename },
        });
      }
      if (buffer.byteLength === 0) {
        throw new AppError('EMPTY_UPLOAD', `"${file.filename}" is empty`, { details: { fileName: file.filename } });
      }
      const plausibleType =
        isSupportedExtension(file.filename) || file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/');
      if (!plausibleType) {
        throw new AppError('UNSUPPORTED_FILE_TYPE', `"${file.filename}" is not a PDF, PNG or JPG file`, {
          details: { fileName: file.filename, mimetype: file.mimetype },
        });
      }

      uploads.push(await store.persist(file.filename, buffer));
    }
  } catch (error) {
    // Never leave a partial batch on disk.
    await store.cleanup(uploads);
    throw error;
  }

  if (uploads.length === 0) {
    throw new AppError('EMPTY_UPLOAD', 'No files were found in the request. Use the "files" field.');
  }

  return uploads;
}
