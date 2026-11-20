import { DomainError } from './errors.js';

/**
 * T3.7 GS1 DataMatrix marking codes (open GS1 General Specifications: Application Identifiers,
 * FNC1 / GS separator). Nothing operator-specific is invented here: only the GS1 element string
 * is parsed. Which AIs a national marking scheme requires is configuration, not code.
 *
 * - `]d2` (symbology identifier) and a leading FNC1 are stripped.
 * - The group separator is ASCII 29 (`\x1d`, what a scanner sends for FNC1 inside the symbol).
 * - Fixed-length AIs: 01 (14), 17 / 11 (6). Variable-length AIs end at GS or at the end.
 * - A code's identity is GTIN + serial (AI 21); the crypto tail (91 / 92 / 93) is kept verbatim.
 */
export const GS = '\x1d';

const FIXED_LENGTH: Readonly<Record<string, number>> = { '01': 14, '17': 6, '11': 6 };
const VARIABLE_MAX: Readonly<Record<string, number>> = {
  '21': 20,
  '10': 20,
  '91': 90,
  '92': 90,
  '93': 90,
  '240': 30,
};

export interface ParsedMarkingCode {
  readonly gtin: string;
  readonly serial: string;
  /** Stable identity of one physical unit: `<gtin>:<serial>`. */
  readonly key: string;
  readonly ais: Readonly<Record<string, string>>;
  /** Normalized element string (no `]d2`, GS kept) — what is stored and sent to a driver. */
  readonly normalized: string;
}

/** GS1 mod-10 check digit of the first n-1 digits equals the last digit. */
export function isValidGtin14(gtin: string): boolean {
  if (!/^[0-9]{14}$/.test(gtin)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i += 1) {
    const d = gtin.charCodeAt(i) - 48;
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === gtin.charCodeAt(13) - 48;
}

function normalizeRaw(raw: string): string {
  let s = raw.replace(/\r|\n/g, '');
  if (s.startsWith(']d2') || s.startsWith(']C1') || s.startsWith(']Q3')) s = s.slice(3);
  // Some scanners send the GS as a visible placeholder; only the real ASCII 29 is accepted here.
  while (s.startsWith(GS)) s = s.slice(1);
  return s;
}

/**
 * True only for strings that look like a GS1 element string with AI 01 and a serial — an EAN-13 /
 * EAN-8 / UPC barcode (8–13 digits, no AIs) is NOT a marking code, so the ordinary scanner path
 * stays untouched.
 */
export function looksLikeMarkingCode(raw: string): boolean {
  const s = normalizeRaw(raw);
  return /^01[0-9]{14}21/.test(s);
}

export function parseMarkingCode(raw: string): ParsedMarkingCode {
  const s = normalizeRaw(raw);
  const ais: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    const ai =
      ['01', '17', '11', '21', '10', '91', '92', '93'].find((a) => s.startsWith(a, i)) ??
      (s.startsWith('240', i) ? '240' : null);
    if (ai === null) {
      throw new DomainError('MARKING_CODE_INVALID', `Unknown GS1 application identifier at ${i}`);
    }
    i += ai.length;
    const fixed = FIXED_LENGTH[ai];
    let value: string;
    if (fixed !== undefined) {
      value = s.slice(i, i + fixed);
      if (value.length !== fixed || !/^[0-9]+$/.test(value)) {
        throw new DomainError('MARKING_CODE_INVALID', `AI ${ai} needs ${fixed} digits`);
      }
      i += fixed;
      if (s[i] === GS) i += 1;
    } else {
      const end = s.indexOf(GS, i);
      value = end < 0 ? s.slice(i) : s.slice(i, end);
      i = end < 0 ? s.length : end + 1;
      const max = VARIABLE_MAX[ai] ?? 90;
      if (value.length === 0 || value.length > max) {
        throw new DomainError('MARKING_CODE_INVALID', `AI ${ai} has an invalid length`);
      }
      if (!/^[\x21-\x7e]+$/.test(value)) {
        throw new DomainError('MARKING_CODE_INVALID', `AI ${ai} has invalid characters`);
      }
    }
    if (ais[ai] !== undefined) {
      throw new DomainError('MARKING_CODE_INVALID', `AI ${ai} repeated`);
    }
    ais[ai] = value;
  }
  const gtin = ais['01'];
  const serial = ais['21'];
  if (gtin === undefined || serial === undefined) {
    throw new DomainError(
      'MARKING_CODE_INVALID',
      'A marking code needs AI 01 (GTIN) and AI 21 (serial)',
    );
  }
  if (!isValidGtin14(gtin)) {
    throw new DomainError('MARKING_CODE_INVALID', 'GTIN check digit is wrong');
  }
  return { gtin, serial, key: `${gtin}:${serial}`, ais, normalized: s };
}

/** A GTIN-14 with a leading 0 is the EAN-13 printed on the pack (catalog barcode lookup). */
export function gtinToEan13(gtin: string): string | null {
  return gtin.startsWith('0') ? gtin.slice(1) : null;
}

/** Units in a cart line quantity (milli-units) when every unit needs its own code. */
export function markedUnitsFromQtyMilli(qtyMilli: bigint): bigint | null {
  return qtyMilli > 0n && qtyMilli % 1000n === 0n ? qtyMilli / 1000n : null;
}
