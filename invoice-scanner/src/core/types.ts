/** Supported input formats. */
export type SupportedMimeType = 'application/pdf' | 'image/png' | 'image/jpeg';

/** Where a page's text came from. */
export type TextSource = 'paddleocr' | 'pdf-text-layer' | 'mock';

/** Axis-aligned bounding box in page coordinates (pixels or PDF points). */
export interface BoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A single recognised text line with its geometry and confidence. */
export interface TextLine {
  /** Stable id within the document: `p{page}-l{index}`. */
  id: string;
  pageNumber: number;
  text: string;
  confidence: number;
  box: BoundingBox;
  /** Box normalised to 0..1 relative to page width/height. */
  normalizedBox: BoundingBox;
  /** True when the line contains Hebrew (or other RTL) characters. */
  rtl: boolean;
}

export interface DocumentPage {
  pageNumber: number;
  width: number;
  height: number;
  source: TextSource;
  lines: TextLine[];
  meanConfidence: number;
  /** Non-fatal problems encountered while reading this page. */
  warnings: string[];
}

export interface OcrDocument {
  fileName: string;
  mimeType: SupportedMimeType;
  pageCount: number;
  pages: DocumentPage[];
  engine: string;
  languages: string[];
  durationMs: number;
  meanConfidence: number;
  warnings: string[];
}

/**
 * The normalised, exported invoice schema. `null` means "not reliably
 * extracted" and is always accompanied by a warning.
 */
export interface Invoice {
  issuer: string | null;
  invoiceDate: string | null;
  invoiceNumber: string | null;
  assignee: string | null;
  invoiceSum: number | null;
  invoiceVat: number | null;
  invoiceSumAndVat: number | null;
  sourceFileName: string;
  warnings: string[];
}

export type InvoiceFieldName =
  | 'issuer'
  | 'invoiceDate'
  | 'invoiceNumber'
  | 'assignee'
  | 'invoiceSum'
  | 'invoiceVat'
  | 'invoiceSumAndVat';

/** A ranked extraction candidate produced by a field extractor. */
export interface FieldCandidate<T = unknown> {
  value: T;
  /** The raw OCR text the value was derived from. */
  raw: string;
  /** 0..1 – combines keyword proximity, layout and OCR confidence. */
  score: number;
  /** Identifier of the rule that produced this candidate. */
  source: string;
  pageNumber: number;
  lineId: string | null;
  /** Human readable explanation, surfaced in debug output. */
  reasons: string[];
}

export interface FieldExtraction<T = unknown> {
  field: InvoiceFieldName;
  selected: FieldCandidate<T> | null;
  alternatives: FieldCandidate<T>[];
}

export type DocumentClassification = 'invoice' | 'probably-invoice' | 'not-an-invoice' | 'unreadable';

export interface DocumentQuality {
  classification: DocumentClassification;
  /** 0..1 confidence that the document is an invoice. */
  invoiceScore: number;
  meanOcrConfidence: number;
  totalCharacters: number;
  matchedKeywords: string[];
  detectedLanguages: string[];
}

export type ValidationSeverity = 'info' | 'warning' | 'error';

export interface ValidationIssue {
  code: string;
  message: string;
  severity: ValidationSeverity;
  field?: InvoiceFieldName;
}

export type InvoiceStatus = 'ok' | 'needs_review' | 'failed';

/** Everything the API knows about one processed file. */
export interface ProcessedInvoice {
  id: string;
  status: InvoiceStatus;
  invoice: Invoice;
  quality: DocumentQuality;
  issues: ValidationIssue[];
  /** Per-field confidence, 0..1, for the values that were selected. */
  fieldConfidence: Partial<Record<InvoiceFieldName, number>>;
  meta: {
    sourceFileName: string;
    mimeType: string;
    byteSize: number;
    pageCount: number;
    ocrEngine: string;
    languages: string[];
    processingMs: number;
  };
  /** Present when the request asks for `?debug=true`. */
  debug?: InvoiceDebugInfo;
}

export interface InvoiceDebugInfo {
  candidates: Record<string, FieldCandidate[]>;
  pages: Array<{
    pageNumber: number;
    source: TextSource;
    meanConfidence: number;
    lineCount: number;
    text: string;
  }>;
}

export interface BatchSummary {
  total: number;
  ok: number;
  needsReview: number;
  failed: number;
}

export interface InvoiceBatch {
  id: string;
  createdAt: string;
  completedAt: string;
  summary: BatchSummary;
  invoices: ProcessedInvoice[];
  /** Files that could not be processed at all (bad type, OCR down, ...). */
  rejected: RejectedFile[];
}

export interface RejectedFile {
  sourceFileName: string;
  code: string;
  message: string;
}

/** Engine-agnostic OCR output for a single page, before normalisation. */
export interface RawTextLine {
  text: string;
  /** 0..1. Sources without a real confidence (PDF text layer) report 0.99. */
  confidence: number;
  box: BoundingBox;
}

export interface RawPage {
  width: number;
  height: number;
  lines: RawTextLine[];
  engine: string;
  warnings?: string[];
}
