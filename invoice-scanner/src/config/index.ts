import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Loads `.env` into `process.env` without an extra dependency.
 * Node >= 20.12 ships `process.loadEnvFile`.
 */
function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch {
    // A malformed .env should not prevent the process from starting with
    // explicitly exported environment variables.
  }
}

const booleanish = z
  .string()
  .transform((value) => ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()));

const csvList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

const csvNumberList = csvList.transform((items) =>
  items.map((item) => Number(item)).filter((item) => Number.isFinite(item)),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanish.default('false'),

  UPLOAD_DIR: z.string().default('./tmp/uploads'),
  KEEP_UPLOADS: booleanish.default('false'),
  MAX_FILE_SIZE_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  MAX_FILES_PER_BATCH: z.coerce.number().int().positive().default(25),
  MAX_PAGES_PER_DOCUMENT: z.coerce.number().int().positive().default(25),

  OCR_PROVIDER: z.enum(['paddle', 'mock']).default('paddle'),
  OCR_SERVICE_URL: z.string().url().default('http://127.0.0.1:8868'),
  OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  OCR_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  OCR_LANGS: csvList.default('en'),
  OCR_PDF_DPI: z.coerce.number().int().min(72).max(600).default(200),
  OCR_MIN_LINE_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.45),
  OCR_CONCURRENCY: z.coerce.number().int().positive().default(2),
  MOCK_OCR_DIR: z.string().default('./tests/fixtures/mock-ocr'),

  PDF_TEXT_LAYER_ENABLED: booleanish.default('true'),
  PDF_TEXT_LAYER_MIN_CHARS: z.coerce.number().int().min(0).default(80),

  DATE_ORDER: z.enum(['DMY', 'MDY']).default('DMY'),
  AMOUNT_TOLERANCE_ABS: z.coerce.number().min(0).default(0.05),
  AMOUNT_TOLERANCE_REL: z.coerce.number().min(0).max(1).default(0.001),
  EXPECTED_VAT_RATES: csvNumberList.default('18,17,20,19,21,23,25'),
  FIELD_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.35),
  INVOICE_MIN_DOCUMENT_SCORE: z.coerce.number().min(0).max(1).default(0.3),
  LOW_QUALITY_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.55),

  BATCH_TTL_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
  MAX_BATCHES_IN_MEMORY: z.coerce.number().int().positive().default(100),
});

export type AppConfig = Readonly<z.infer<typeof schema>> & {
  readonly uploadDirAbsolute: string;
  readonly mockOcrDirAbsolute: string;
};

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  return Object.freeze({
    ...parsed.data,
    uploadDirAbsolute: path.resolve(process.cwd(), parsed.data.UPLOAD_DIR),
    mockOcrDirAbsolute: path.resolve(process.cwd(), parsed.data.MOCK_OCR_DIR),
  });
}

/** Process-wide configuration singleton. */
export function getConfig(): AppConfig {
  if (!cached) {
    loadDotEnv();
    cached = loadConfig();
  }
  return cached;
}

/** Test helper: force the singleton to be rebuilt on next access. */
export function resetConfigCache(): void {
  cached = null;
}
