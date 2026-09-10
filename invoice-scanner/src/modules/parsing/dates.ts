import { normalizeLine } from '../../utils/text.js';

export interface DateMatch {
  /** Normalised `YYYY-MM-DD`. */
  iso: string;
  raw: string;
  index: number;
  /** True when day/month order could not be determined from the value alone. */
  ambiguous: boolean;
  /** Two-digit years were expanded and are less trustworthy. */
  shortYear: boolean;
}

export type DateOrder = 'DMY' | 'MDY';

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, ינואר: 1,
  feb: 2, february: 2, פברואר: 2,
  mar: 3, march: 3, מרץ: 3, מרס: 3,
  apr: 4, april: 4, אפריל: 4,
  may: 5, מאי: 5,
  jun: 6, june: 6, יוני: 6,
  jul: 7, july: 7, יולי: 7,
  aug: 8, august: 8, אוגוסט: 8,
  sep: 9, sept: 9, september: 9, ספטמבר: 9,
  oct: 10, october: 10, אוקטובר: 10,
  nov: 11, november: 11, נובמבר: 11,
  dec: 12, december: 12, דצמבר: 12,
};

const NUMERIC_DATE = /(\d{1,4})\s*[./\-]\s*(\d{1,2})\s*[./\-]\s*(\d{2,4})/g;
const TEXTUAL_DATE_DMY = /(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z֐-׿]{3,12})\.?,?\s+(\d{2,4})/g;
const TEXTUAL_DATE_MDY = /([A-Za-z֐-׿]{3,12})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})/g;
const COMPACT_DATE = /\b(20\d{2}|19\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/g;

function expandYear(year: number): { year: number; shortYear: boolean } {
  if (year >= 1000) return { year, shortYear: false };
  if (year >= 70) return { year: 1900 + year, shortYear: true };
  return { year: 2000 + year, shortYear: true };
}

function isValid(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (year < 1990 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthFromName(name: string): number | null {
  const key = name.toLowerCase().replace(/[^a-z֐-׿]/g, '');
  if (MONTH_NAMES[key]) return MONTH_NAMES[key];
  // Hebrew attaches prepositions to the month name ("בפברואר" = "in February").
  const withoutPrefix = /^[בלמהוכש]/.test(key) ? key.slice(1) : key;
  if (MONTH_NAMES[withoutPrefix]) return MONTH_NAMES[withoutPrefix];
  return MONTH_NAMES[key.slice(0, 3)] ?? null;
}

/**
 * Finds every date in a line and normalises it to ISO.
 * `order` decides how `03/04/2025` is read when both parts are <= 12.
 */
export function findDates(text: string, order: DateOrder = 'DMY'): DateMatch[] {
  const line = normalizeLine(text);
  const matches: DateMatch[] = [];
  const seen = new Set<string>();

  const push = (match: DateMatch): void => {
    const key = `${match.iso}@${match.index}`;
    if (seen.has(key)) return;
    seen.add(key);
    matches.push(match);
  };

  for (const match of line.matchAll(COMPACT_DATE)) {
    const [raw, y, m, d] = match;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    if (isValid(year, month, day)) {
      push({ iso: toIso(year, month, day), raw, index: match.index ?? 0, ambiguous: false, shortYear: false });
    }
  }

  for (const match of line.matchAll(NUMERIC_DATE)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const first = Number(match[1]);
    const second = Number(match[2]);
    const thirdRaw = Number(match[3]);

    // ISO-ish: 2025-04-03
    if ((match[1] as string).length === 4) {
      if (isValid(first, second, thirdRaw)) {
        push({ iso: toIso(first, second, thirdRaw), raw, index, ambiguous: false, shortYear: false });
      }
      continue;
    }

    const { year, shortYear } = expandYear(thirdRaw);
    const dmyValid = isValid(year, second, first);
    const mdyValid = isValid(year, first, second);
    const ambiguous = dmyValid && mdyValid && first !== second;

    const preferDmy = order === 'DMY' ? dmyValid : !mdyValid && dmyValid;
    if (preferDmy) {
      push({ iso: toIso(year, second, first), raw, index, ambiguous, shortYear });
    } else if (mdyValid) {
      push({ iso: toIso(year, first, second), raw, index, ambiguous, shortYear });
    }
  }

  for (const match of line.matchAll(TEXTUAL_DATE_DMY)) {
    const month = monthFromName(match[2] as string);
    if (month === null) continue;
    const { year, shortYear } = expandYear(Number(match[3]));
    const day = Number(match[1]);
    if (isValid(year, month, day)) {
      push({ iso: toIso(year, month, day), raw: match[0], index: match.index ?? 0, ambiguous: false, shortYear });
    }
  }

  for (const match of line.matchAll(TEXTUAL_DATE_MDY)) {
    const month = monthFromName(match[1] as string);
    if (month === null) continue;
    const { year, shortYear } = expandYear(Number(match[3]));
    const day = Number(match[2]);
    if (isValid(year, month, day)) {
      push({ iso: toIso(year, month, day), raw: match[0], index: match.index ?? 0, ambiguous: false, shortYear });
    }
  }

  return matches.sort((a, b) => a.index - b.index);
}

/** Convenience wrapper returning the first date found in a string. */
export function parseDate(text: string, order: DateOrder = 'DMY'): DateMatch | null {
  return findDates(text, order)[0] ?? null;
}
