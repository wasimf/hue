import { foldForMatch } from '../../utils/text.js';

/**
 * Bilingual (Hebrew + English) keyword dictionaries.
 *
 * Terms are written in their natural form and folded with the same function
 * used on OCR text, so `מע"מ`, `מע״מ` and `מעמ` all resolve to a match.
 * Adding a language means adding terms here – no extractor changes required.
 */
export const KEYWORDS = {
  /** Evidence that the document is an invoice at all. */
  invoiceDocument: [
    'tax invoice',
    'invoice',
    'vat invoice',
    'commercial invoice',
    'invoice / receipt',
    'bill',
    'חשבונית מס',
    'חשבונית מס קבלה',
    'חשבונית',
    'חשבונית עסקה',
    'חשבונית מס/קבלה',
    'מס קבלה',
    'rechnung',
    'facture',
    'factura',
  ],
  invoiceNumber: [
    'invoice number',
    'invoice no',
    'invoice #',
    'invoice num',
    'inv no',
    'inv #',
    'bill number',
    'document number',
    'document no',
    'reference number',
    'מספר חשבונית',
    'חשבונית מספר',
    'מס חשבונית',
    "מס' חשבונית",
    'חשבונית מס מספר',
    'מספר מסמך',
    'מספר אסמכתא',
    'אסמכתא',
    'מספר',
  ],
  issueDate: [
    'invoice date',
    'date of issue',
    'issue date',
    'issued on',
    'issued',
    'date',
    'תאריך חשבונית',
    'תאריך הפקה',
    'תאריך הנפקה',
    'תאריך יצירה',
    'תאריך',
    'הופק בתאריך',
  ],
  /** Dates that must NOT be reported as the invoice date. */
  otherDate: [
    'due date',
    'payment due',
    'due on',
    'delivery date',
    'service period',
    'period',
    'valid until',
    'תאריך פרעון',
    'תאריך פירעון',
    'מועד תשלום',
    'לתשלום עד',
    'תאריך אספקה',
    'תוקף',
    'תקופת חיוב',
  ],
  subtotal: [
    'subtotal',
    'sub total',
    'net amount',
    'net total',
    'total excluding vat',
    'total before vat',
    'total excl vat',
    'amount before vat',
    'taxable amount',
    'net',
    'סה כ לפני מע מ',
    'סהכ לפני מעמ',
    'סכום לפני מע מ',
    'לפני מע מ',
    'לפני מעמ',
    'סכום ביניים',
    'סה כ ביניים',
    'מחיר לפני מע מ',
    'סכום חייב במע מ',
  ],
  vat: [
    'vat',
    'v a t',
    'value added tax',
    'tax amount',
    'sales tax',
    'gst',
    'מע מ',
    'מעמ',
    'מס ערך מוסף',
    'מע מ 18',
    'מע מ 17',
  ],
  total: [
    'total including vat',
    'total incl vat',
    'total with vat',
    'grand total',
    'total due',
    'amount due',
    'total payable',
    'balance due',
    'total amount',
    'total',
    'סה כ לתשלום',
    'סהכ לתשלום',
    'סה כ כולל מע מ',
    'סהכ כולל מעמ',
    'סה כ כולל',
    'לתשלום',
    'סך הכל לתשלום',
    'סך הכל',
    'סה כ',
    'סהכ',
    'יתרה לתשלום',
    'סכום לתשלום',
  ],
  billTo: [
    'bill to',
    'billed to',
    'invoice to',
    'sold to',
    'customer',
    'client',
    'customer name',
    'account name',
    'ship to',
    'לכבוד',
    'עבור',
    'שם הלקוח',
    'פרטי הלקוח',
    'לקוח',
    'שם החברה',
    'ללקוח',
  ],
  issuer: [
    'from',
    'seller',
    'supplier',
    'vendor',
    'issued by',
    'remit to',
    'מאת',
    'ספק',
    'המוכר',
    'עוסק מורשה',
    'עוסק פטור',
    'הופק על ידי',
  ],
  /** Legal-entity suffixes; strong evidence a line is a company name. */
  companySuffix: [
    'ltd',
    'ltd.',
    'limited',
    'inc',
    'inc.',
    'llc',
    'l.l.c',
    'plc',
    'gmbh',
    'ag',
    'bv',
    'b.v.',
    'nv',
    'sarl',
    'sa',
    's.a.',
    'srl',
    'oy',
    'ab',
    'as',
    'aps',
    'co',
    'corp',
    'corporation',
    'company',
    'בע מ',
    'בעמ',
    'שותפות מוגבלת',
    'עמותה',
    'חל צ',
  ],
  /** Business registration identifiers, useful to anchor issuer/assignee. */
  companyId: [
    'company id',
    'company number',
    'reg no',
    'registration number',
    'vat id',
    'vat number',
    'tax id',
    'ein',
    'ח פ',
    'חפ',
    'ע מ',
    'עמ',
    'ת ז',
    'תז',
    'מספר עוסק',
    'עוסק מורשה',
    'מספר ח פ',
  ],
  /** Documents that look like invoices but are not. */
  nonInvoice: [
    'purchase order',
    'quotation',
    'quote',
    'proforma',
    'pro forma',
    'delivery note',
    'packing list',
    'statement of account',
    'credit note',
    'הצעת מחיר',
    'הזמנת רכש',
    'תעודת משלוח',
    'דו ח מרכז',
    'כרטסת',
    'זיכוי',
    'חשבונית זיכוי',
  ],
  currency: ['ils', 'nis', 'shekel', 'usd', 'eur', 'gbp', 'ש ח', 'שח', 'שקל', 'שקלים', 'dollar', 'euro'],
} as const;

export type KeywordCategory = keyof typeof KEYWORDS;

export interface KeywordMatch {
  category: KeywordCategory;
  term: string;
  /** Index of the match inside the folded text. */
  index: number;
  /** Match length relative to the whole folded line, 0..1. */
  coverage: number;
  /** True when the line contains (almost) nothing but the keyword. */
  isLabelOnly: boolean;
}

const FOLDED: Record<string, Array<{ term: string; folded: string }>> = Object.fromEntries(
  Object.entries(KEYWORDS).map(([category, terms]) => [
    category,
    // Longest first so "total including vat" wins over "total".
    [...terms]
      .map((term) => ({ term, folded: foldForMatch(term) }))
      .filter((entry) => entry.folded.length > 0)
      .sort((a, b) => b.folded.length - a.folded.length),
  ]),
);

/** Word-boundary aware search that also works for Hebrew (no \b support). */
function findTerm(foldedText: string, foldedTerm: string): number {
  let from = 0;
  for (;;) {
    const index = foldedText.indexOf(foldedTerm, from);
    if (index === -1) return -1;
    const before = index === 0 ? ' ' : foldedText[index - 1];
    const afterIndex = index + foldedTerm.length;
    const after = afterIndex >= foldedText.length ? ' ' : foldedText[afterIndex];
    const isBoundary = (char: string | undefined): boolean => char === undefined || !/[0-9a-z֐-׿]/u.test(char);
    if (isBoundary(before) && isBoundary(after)) return index;
    from = index + 1;
  }
}

/** Returns the best (longest) keyword match of `category` within `text`. */
export function matchKeyword(text: string, category: KeywordCategory): KeywordMatch | null {
  const folded = foldForMatch(text);
  if (!folded) return null;
  for (const entry of FOLDED[category] ?? []) {
    const index = findTerm(folded, entry.folded);
    if (index >= 0) {
      const coverage = entry.folded.length / folded.length;
      return {
        category,
        term: entry.term,
        index,
        coverage,
        // Allow for a colon, a currency symbol or a short suffix.
        isLabelOnly: folded.length - entry.folded.length <= 3,
      };
    }
  }
  return null;
}

export function matchesAny(text: string, categories: readonly KeywordCategory[]): KeywordMatch | null {
  for (const category of categories) {
    const match = matchKeyword(text, category);
    if (match) return match;
  }
  return null;
}

/** All categories that match anywhere in `text`, used for document scoring. */
export function collectCategories(text: string): KeywordCategory[] {
  return (Object.keys(KEYWORDS) as KeywordCategory[]).filter((category) => matchKeyword(text, category) !== null);
}
