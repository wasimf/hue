/**
 * Application error taxonomy.
 *
 * Every stage of the pipeline throws one of these so that the HTTP layer can
 * map failures onto status codes without knowing pipeline internals, and so a
 * failure on one document never aborts a whole batch.
 */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_FILES'
  | 'EMPTY_UPLOAD'
  | 'DOCUMENT_LOAD_FAILED'
  | 'OCR_UNAVAILABLE'
  | 'OCR_FAILED'
  | 'PARSING_FAILED'
  | 'NOT_FOUND'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNSUPPORTED_FILE_TYPE: 415,
  FILE_TOO_LARGE: 413,
  TOO_MANY_FILES: 413,
  EMPTY_UPLOAD: 400,
  DOCUMENT_LOAD_FAILED: 422,
  OCR_UNAVAILABLE: 503,
  OCR_FAILED: 502,
  PARSING_FAILED: 422,
  NOT_FOUND: 404,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: { details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Normalises anything thrown into an AppError. */
export function toAppError(error: unknown, fallbackCode: ErrorCode = 'INTERNAL'): AppError {
  if (isAppError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AppError(fallbackCode, message, { cause: error });
}
