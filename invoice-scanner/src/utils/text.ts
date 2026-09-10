/** Text normalisation helpers shared by every extractor (Hebrew + English). */

const HEBREW = /[֐-׿יִ-ﭏ]/;
const ARABIC = /[؀-ۿ]/;
const HEBREW_DIACRITICS = /[֑-ׇ]/g;
/** LRM/RLM/LRE..RLO/PDF and the isolate controls. */
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/g;
/** Arabic-Indic and extended Arabic-Indic digits. */
const EASTERN_DIGITS = /[٠-٩۰-۹]/g;
/** NBSP, thin/hair spaces, zero-width space. */
const EXOTIC_SPACES = /[   -​  　]/g;

export function containsHebrew(text: string): boolean {
  return HEBREW.test(text);
}

export function containsRtl(text: string): boolean {
  return HEBREW.test(text) || ARABIC.test(text);
}

export function containsLatin(text: string): boolean {
  return /[A-Za-z]/.test(text);
}

export function stripBidiControls(text: string): string {
  return text.replace(BIDI_CONTROLS, '');
}

/** Maps Hebrew gershayim/geresh and typographic quotes onto ASCII equivalents. */
export function normalizeQuotes(text: string): string {
  return text
    .replace(/[״“”„«»]/g, '"')
    .replace(/[׳‘’′`]/g, "'");
}

export function normalizeDigits(text: string): string {
  return text.replace(EASTERN_DIGITS, (digit) => {
    const code = digit.codePointAt(0) as number;
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

export function normalizeWhitespace(text: string): string {
  return text.replace(EXOTIC_SPACES, ' ').replace(/\s+/g, ' ').trim();
}

/** Full normalisation applied to every OCR line before parsing. */
export function normalizeLine(text: string): string {
  return normalizeWhitespace(normalizeDigits(normalizeQuotes(stripBidiControls(text))));
}

/**
 * Aggressive folding used for keyword matching only: lower-cased, quote and
 * diacritic free, punctuation collapsed to single spaces.
 */
export function foldForMatch(text: string): string {
  return normalizeWhitespace(
    normalizeLine(text)
      .toLowerCase()
      .replace(HEBREW_DIACRITICS, '')
      .replace(/["'`.,:;!?()[\]{}<>|\\/*_=+~^־–—-]/g, ' '),
  );
}

/** Removes label noise from an extracted entity name. */
export function cleanEntityName(text: string): string {
  return normalizeLine(text)
    .replace(/^[\s:|_*#\-–—]+/, '')
    .replace(/[\s:|_*#\-–—]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Character-level Dice coefficient on bigrams; used for de-duplication. */
export function similarity(a: string, b: string): number {
  const left = foldForMatch(a);
  const right = foldForMatch(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const bigrams = (value: string): string[] =>
    Array.from({ length: Math.max(0, value.length - 1) }, (_, index) => value.slice(index, index + 2));
  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  if (leftGrams.length === 0 || rightGrams.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const gram of leftGrams) pool.set(gram, (pool.get(gram) ?? 0) + 1);
  let hits = 0;
  for (const gram of rightGrams) {
    const count = pool.get(gram) ?? 0;
    if (count > 0) {
      hits += 1;
      pool.set(gram, count - 1);
    }
  }
  return (2 * hits) / (leftGrams.length + rightGrams.length);
}

/** Ratio of characters that look like OCR noise; a cheap quality signal. */
export function noiseRatio(text: string): number {
  const stripped = normalizeLine(text).replace(/\s/g, '');
  if (stripped.length === 0) return 1;
  const meaningful = stripped.replace(/[^0-9A-Za-z֐-׿؀-ۿ.,:%/'"()+₪$€£-]/g, '');
  return 1 - meaningful.length / stripped.length;
}
