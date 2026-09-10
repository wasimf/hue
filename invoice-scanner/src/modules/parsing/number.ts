import { normalizeLine } from '../../utils/text.js';

export interface NumericToken {
  /** The matched substring, as it appeared in the normalised line. */
  raw: string;
  value: number;
  /** Offset inside the normalised line. */
  index: number;
  isPercent: boolean;
  isNegative: boolean;
  hasCurrencySymbol: boolean;
  /** Number of decimal places found in the source text. */
  decimals: number;
}

const CURRENCY_SYMBOLS = /[₪$€£¥]/;
/**
 * Number-like runs. The first alternative covers space-grouped thousands
 * (`1 234,56`); the second covers dot/comma grouped and plain numbers. Spaces
 * are only allowed between full 3-digit groups so that `120.00 300` is read as
 * two separate amounts.
 */
const NUMBER_PATTERN =
  /-?\(?\d{1,3}(?:[   ]\d{3})+(?:[.,]\d{1,2})?\)?|-?\(?\d+(?:[.,]\d+)*\)?/g;

/** Rounds to 2 decimals while avoiding binary floating point artefacts. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Resolves a number that uses a single separator character, deciding whether
 * that separator groups thousands or introduces the decimal part.
 */
function resolveSingleSeparator(digits: string, separator: string): string {
  const parts = digits.split(separator);
  if (parts.length < 2) return digits;
  const last = parts[parts.length - 1] as string;
  const groupsLookLikeThousands = parts.slice(1).every((part) => part.length === 3);
  if (last.length === 3 && groupsLookLikeThousands) {
    // 1.234 / 1,234 / 1.234.567 -> pure grouping.
    return parts.join('');
  }
  return `${parts.slice(0, -1).join('')}.${last}`;
}

/**
 * Parses a single amount string. Handles `1,234.56`, `1.234,56`, `1 234,56`,
 * `1234.5`, `(1,234.56)` and trailing/leading minus signs.
 */
export function parseAmount(raw: string): number | null {
  const text = normalizeLine(raw);
  if (!text) return null;

  const negative = /^\s*-/.test(text) || /-\s*$/.test(text) || /^\s*\(.*\)\s*$/.test(text);
  let digits = text.replace(/[^\d.,']/g, '').replace(/'/g, '');
  if (!/\d/.test(digits)) return null;

  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    // The right-most separator is the decimal one, the other groups thousands.
    const decimalSeparator = lastComma > lastDot ? ',' : '.';
    const thousandSeparator = decimalSeparator === ',' ? '.' : ',';
    digits = digits.split(thousandSeparator).join('');
    const parts = digits.split(decimalSeparator);
    const last = parts.pop() as string;
    digits = `${parts.join('')}.${last}`;
  } else if (lastComma >= 0) {
    digits = resolveSingleSeparator(digits, ',');
  } else if (lastDot >= 0) {
    digits = resolveSingleSeparator(digits, '.');
  }

  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** Extracts every number-like token from a line, with parsing metadata. */
export function extractNumericTokens(line: string): NumericToken[] {
  const text = normalizeLine(line);
  const tokens: NumericToken[] = [];
  NUMBER_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - 2), index);
    const after = text.slice(index + raw.length, index + raw.length + 2);
    const value = parseAmount(raw);
    if (value === null) continue;

    const isPercent = /^\s*%/.test(after);
    const isNegative = value < 0 || /-\s*$/.test(after) || /^\(/.test(raw);
    const decimalMatch = /[.,](\d+)$/.exec(raw);

    tokens.push({
      raw,
      value: isNegative ? -Math.abs(value) : value,
      index,
      isPercent,
      isNegative,
      hasCurrencySymbol: CURRENCY_SYMBOLS.test(before) || CURRENCY_SYMBOLS.test(after),
      decimals: decimalMatch?.[1]?.length ?? 0,
    });
  }

  return tokens;
}

/** True when `a` and `b` are equal within the configured tolerances. */
export function amountsMatch(
  a: number,
  b: number,
  tolerance: { absolute: number; relative: number },
): boolean {
  const delta = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return delta <= Math.max(tolerance.absolute, scale * tolerance.relative);
}
