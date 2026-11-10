import { DomainError } from './errors.js';
import { type Money, moneyToTiyin } from './money.js';
import { type Quantity, quantityToMilli } from './quantity.js';

export const PRODUCT_UNITS = ['dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq'] as const;
export type ProductUnit = (typeof PRODUCT_UNITS)[number];

const INTEGER_ONLY_UNITS: ReadonlySet<ProductUnit> = new Set<ProductUnit>(['dona', 'qadoq']);

export const BARCODE_FORMATS = ['ean13', 'ean8', 'upca', 'internal', 'other'] as const;
export type BarcodeFormat = (typeof BARCODE_FORMATS)[number];

export const MAX_CATALOG_NAME_LENGTH = 200;
export const MAX_CATALOG_SKU_LENGTH = 64;
export const MAX_CATALOG_BARCODE_LENGTH = 64;
export const MAX_FISCAL_CODE_LENGTH = 32;
export const MAX_PRICE_CHANGE_REASON_LENGTH = 250;
export const MAX_CATALOG_SEARCH_TOKENS = 16;
export const MAX_VARIANT_ATTRIBUTE_KEYS = 20;

const CONTROL_CHAR_REGEX = /[\u0000-\u001f\u007f]/;
const BARCODE_ALLOWED_REGEX = /^[A-Za-z0-9._-]+$/;
const DIGITS_ONLY_REGEX = /^\d+$/;
const FISCAL_CODE_ALLOWED_REGEX = /^[A-Za-z0-9._/-]+$/;

const APOSTROPHE_AND_SIGN_CHARS: ReadonlySet<string> = new Set([
  '\u0027', // '
  '\u02bb', // ʻ
  '\u02bc', // ʼ
  '\u2018', // ‘
  '\u2019', // ’
  '\u201b', // ‛
  '\u0060', // `
  '\u00b4', // ´
  '\u02c8', // ˈ
  '\u02ee', // ˮ
  '\u2032', // ′
  '\u02ba', // ʺ
  '\u044a', // ъ (tutuq / hard sign)
  '\u044c', // ь (soft sign)
]);

const CYRILLIC_TO_LATIN_FIXED: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  ё: 'yo',
  ж: 'j',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'x',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ы: 'i',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  ў: 'o',
  ғ: 'g',
  қ: 'q',
  ҳ: 'h',
};

const LATIN_DIACRITIC_MAP: Readonly<Record<string, string>> = {
  á: 'a',
  à: 'a',
  â: 'a',
  ä: 'a',
  ã: 'a',
  å: 'a',
  ç: 'c',
  é: 'e',
  è: 'e',
  ê: 'e',
  ë: 'e',
  ğ: 'g',
  í: 'i',
  ì: 'i',
  î: 'i',
  ï: 'i',
  ı: 'i',
  ñ: 'n',
  ó: 'o',
  ò: 'o',
  ô: 'o',
  ö: 'o',
  õ: 'o',
  ø: 'o',
  ş: 'sh',
  ú: 'u',
  ù: 'u',
  û: 'u',
  ü: 'u',
  ý: 'y',
  ÿ: 'y',
};

const VOWEL_TRIGGER_CHARS: ReadonlySet<string> = new Set([
  'а',
  'е',
  'ё',
  'и',
  'о',
  'у',
  'ы',
  'э',
  'ю',
  'я',
  'ў',
  'a',
  'e',
  'i',
  'o',
  'u',
]);

function isAsciiLowerAlnum(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

function isWordBoundaryOrVowelBeforeIe(prevRawChar: string | null): boolean {
  if (prevRawChar === null) {
    return true;
  }
  if (APOSTROPHE_AND_SIGN_CHARS.has(prevRawChar) || VOWEL_TRIGGER_CHARS.has(prevRawChar)) {
    return true;
  }
  // Treat any whitespace or punctuation preceding 'е' as a word boundary -> 'ye'
  return (
    !isAsciiLowerAlnum(prevRawChar) &&
    !(prevRawChar >= 'а' && prevRawChar <= 'я') &&
    prevRawChar !== 'ў' &&
    prevRawChar !== 'ғ' &&
    prevRawChar !== 'қ' &&
    prevRawChar !== 'ҳ' &&
    prevRawChar !== 'ё'
  );
}

export function isProductUnit(value: unknown): value is ProductUnit {
  return typeof value === 'string' && (PRODUCT_UNITS as readonly string[]).includes(value);
}

export function parseProductUnit(value: unknown): ProductUnit {
  if (!isProductUnit(value)) {
    throw new DomainError('INVALID_UNIT', `Unit must be one of: ${PRODUCT_UNITS.join(', ')}`);
  }
  return value;
}

export function isIntegerOnlyUnit(unit: ProductUnit): boolean {
  return INTEGER_ONLY_UNITS.has(unit);
}

export function validateQuantityForUnit(
  unit: ProductUnit,
  quantity: Quantity,
  options?: { readonly allowZero?: boolean },
): Quantity {
  const validUnit = parseProductUnit(unit);
  const milli = quantityToMilli(quantity);

  if (milli < 0n) {
    throw new DomainError('INVALID_UNIT_QUANTITY', 'Quantity must not be negative');
  }
  if (!options?.allowZero && milli === 0n) {
    throw new DomainError('INVALID_UNIT_QUANTITY', 'Quantity must be greater than zero');
  }
  if (INTEGER_ONLY_UNITS.has(validUnit) && milli % 1000n !== 0n) {
    throw new DomainError(
      'INVALID_UNIT_QUANTITY',
      `Unit "${validUnit}" only allows whole-unit quantities`,
    );
  }

  return quantity;
}

export function validateNonNegativeSalePrice(price: Money, label = 'Sale price'): Money {
  if (moneyToTiyin(price) < 0n) {
    throw new DomainError('VALIDATION_ERROR', `${label} must not be negative`);
  }
  return price;
}

export function normalizeCatalogDisplayName(
  raw: string,
  fieldLabel = 'Name',
  maxLength = MAX_CATALOG_NAME_LENGTH,
): string {
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', `${fieldLabel} must be a string`);
  }
  const nfc = raw.normalize('NFC');
  if (CONTROL_CHAR_REGEX.test(nfc)) {
    throw new DomainError('VALIDATION_ERROR', `${fieldLabel} must not contain control characters`);
  }
  const cleaned = nfc.trim().replace(/\s+/g, ' ');
  if (cleaned.length === 0 || cleaned.length > maxLength) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `${fieldLabel} must be between 1 and ${String(maxLength)} characters`,
    );
  }
  return cleaned;
}

export function normalizeCatalogSku(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', 'SKU must be a string');
  }
  const nfc = raw.normalize('NFC');
  if (CONTROL_CHAR_REGEX.test(nfc)) {
    throw new DomainError('VALIDATION_ERROR', 'SKU must not contain control characters');
  }
  const trimmed = nfc.trim();
  if (trimmed.length === 0) {
    throw new DomainError('VALIDATION_ERROR', 'SKU must not be empty when provided');
  }
  if (trimmed.length > MAX_CATALOG_SKU_LENGTH) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `SKU must not exceed ${String(MAX_CATALOG_SKU_LENGTH)} characters`,
    );
  }
  return trimmed;
}

export function normalizeFiscalCode(
  raw: string | null | undefined,
  fieldLabel: string,
): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', `${fieldLabel} must be a string`);
  }
  const trimmed = raw.normalize('NFC').trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_FISCAL_CODE_LENGTH || !FISCAL_CODE_ALLOWED_REGEX.test(trimmed)) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `${fieldLabel} must be 1–${String(MAX_FISCAL_CODE_LENGTH)} safe ASCII characters`,
    );
  }
  return trimmed;
}

export function normalizePriceChangeReason(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new DomainError('VALIDATION_ERROR', 'Reason must be a string');
  }
  const nfc = raw.normalize('NFC');
  if (CONTROL_CHAR_REGEX.test(nfc)) {
    throw new DomainError('VALIDATION_ERROR', 'Reason must not contain control characters');
  }
  const cleaned = nfc.trim().replace(/\s+/g, ' ');
  if (cleaned.length === 0) {
    return null;
  }
  if (cleaned.length > MAX_PRICE_CHANGE_REASON_LENGTH) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Reason must not exceed ${String(MAX_PRICE_CHANGE_REASON_LENGTH)} characters`,
    );
  }
  return cleaned;
}

/**
 * Normalizes product/category names and SKUs into a deterministic, ASCII-only Uzbek-Latin search key:
 * - Unicode NFC + lowercase
 * - Uzbek/Russian Cyrillic transliteration (`х -> x`, `ҳ -> h`, `қ -> q`, `ў -> o`, `ғ -> g`, etc.)
 * - Removes `ъ`, `ь`, and all apostrophe variants (`'`, `ʻ`, `ʼ`, `‘`, `’`, `` ` ``, etc.) in-place (`маъно -> mano`)
 * - Converts punctuation/separators (`-`, `_`, `/`, `:`, `*`, `"`, `(`, `)`) into single space (`Coca-Cola Zero -> coca cola zero`)
 */
export function normalizeCatalogSearchText(input: string): string {
  if (typeof input !== 'string') {
    throw new DomainError('VALIDATION_ERROR', 'Search text must be a string');
  }

  const lower = input.normalize('NFC').toLowerCase();
  const out: string[] = [];

  const pushSpace = (): void => {
    if (out.length > 0 && out[out.length - 1] !== ' ') {
      out.push(' ');
    }
  };

  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (ch === undefined) {
      continue;
    }

    if (APOSTROPHE_AND_SIGN_CHARS.has(ch)) {
      continue;
    }

    if (isAsciiLowerAlnum(ch)) {
      out.push(ch);
      continue;
    }

    if (ch === 'е') {
      const prev = i > 0 ? (lower[i - 1] ?? null) : null;
      out.push(isWordBoundaryOrVowelBeforeIe(prev) ? 'ye' : 'e');
      continue;
    }

    if (ch === 'ц') {
      const prev = i > 0 ? (lower[i - 1] ?? null) : null;
      out.push(prev !== null && VOWEL_TRIGGER_CHARS.has(prev) ? 'ts' : 's');
      continue;
    }

    const mappedCyr = CYRILLIC_TO_LATIN_FIXED[ch];
    if (mappedCyr !== undefined) {
      out.push(mappedCyr);
      continue;
    }

    const mappedLatin = LATIN_DIACRITIC_MAP[ch];
    if (mappedLatin !== undefined) {
      out.push(mappedLatin);
      continue;
    }

    pushSpace();
  }

  if (out.length > 0 && out[out.length - 1] === ' ') {
    out.pop();
  }

  return out.join('');
}

export function tokenizeCatalogSearchQuery(rawQuery: string): readonly string[] {
  const normalized = normalizeCatalogSearchText(rawQuery);
  if (normalized.length === 0) {
    return [];
  }
  const parts = normalized.split(' ').filter((tok) => tok.length > 0);
  if (parts.length > MAX_CATALOG_SEARCH_TOKENS) {
    return parts.slice(0, MAX_CATALOG_SEARCH_TOKENS);
  }
  return parts;
}

/**
 * Builds an injection-safe SQLite FTS5 `MATCH` expression from raw cashier input.
 * Every normalized token contains strictly `[a-z0-9]+` and is emitted as `"tok"*` joined by `AND`,
 * neutralizing `"`, `*`, `-`, `:`, `(`, `NEAR`, `OR`, `AND`, `NOT`, etc.
 */
export function buildFtsPrefixQuery(rawQuery: string): string | null {
  const tokens = tokenizeCatalogSearchQuery(rawQuery);
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((tok) => `"${tok}"*`).join(' AND ');
}

export function isBarcodeFormat(value: unknown): value is BarcodeFormat {
  return typeof value === 'string' && (BARCODE_FORMATS as readonly string[]).includes(value);
}

export function normalizeBarcodeInput(raw: string): string {
  if (typeof raw !== 'string') {
    throw new DomainError('INVALID_BARCODE', 'Barcode must be a string');
  }
  const cleaned = raw.replace(/\s+/g, '');
  if (
    cleaned.length === 0 ||
    cleaned.length > MAX_CATALOG_BARCODE_LENGTH ||
    !BARCODE_ALLOWED_REGEX.test(cleaned)
  ) {
    throw new DomainError(
      'INVALID_BARCODE',
      `Barcode must be 1–${String(MAX_CATALOG_BARCODE_LENGTH)} characters from [A-Za-z0-9._-]`,
    );
  }
  return cleaned;
}

/**
 * Computes GS1 Modulo-10 check digit for payload digits (length 7 for EAN-8, 11 for UPC-A, 12 for EAN-13).
 */
export function computeGs1CheckDigit(payloadDigits: string): number {
  if (!DIGITS_ONLY_REGEX.test(payloadDigits) || payloadDigits.length === 0) {
    throw new DomainError('INVALID_BARCODE', 'GS1 payload must contain only digits');
  }
  let sum = 0;
  let weight = 3;
  for (let i = payloadDigits.length - 1; i >= 0; i--) {
    const digit = payloadDigits.charCodeAt(i) - 48;
    sum += digit * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Verifies GS1 Modulo-10 check digit for EAN-8 (8 digits), UPC-A (12 digits), or EAN-13 (13 digits).
 */
export function verifyGs1CheckDigit(code: string): boolean {
  if (
    typeof code !== 'string' ||
    !DIGITS_ONLY_REGEX.test(code) ||
    (code.length !== 8 && code.length !== 12 && code.length !== 13)
  ) {
    return false;
  }
  const payload = code.slice(0, code.length - 1);
  const actualCheckDigit = code.charCodeAt(code.length - 1) - 48;
  return computeGs1CheckDigit(payload) === actualCheckDigit;
}

export interface PreparedBarcodeStorage {
  readonly barcode: string;
  readonly format: BarcodeFormat;
}

/**
 * Normalizes and validates a barcode for persistent catalog registration:
 * - Enforces GS1 Modulo-10 check digit on `ean13`, `ean8`, `upca` (and auto-detected 8/12/13-digit GS1 codes unless explicitly marked `internal`/`other`).
 * - Canonicalizes 12-digit UPC-A to 13-digit EAN-13 form (`'0' + upca`) so `036000291452` and `0036000291452` share the same unique key.
 */
export function prepareBarcodeForStorage(
  rawBarcode: string,
  requestedFormat?: BarcodeFormat,
): PreparedBarcodeStorage {
  const cleaned = normalizeBarcodeInput(rawBarcode);

  if (requestedFormat !== undefined && !isBarcodeFormat(requestedFormat)) {
    throw new DomainError(
      'INVALID_BARCODE',
      `Barcode format must be one of: ${BARCODE_FORMATS.join(', ')}`,
    );
  }

  const format: BarcodeFormat =
    requestedFormat ??
    (DIGITS_ONLY_REGEX.test(cleaned)
      ? cleaned.length === 13
        ? 'ean13'
        : cleaned.length === 12
          ? 'upca'
          : cleaned.length === 8
            ? 'ean8'
            : 'internal'
      : 'internal');

  if (format === 'internal' || format === 'other') {
    return { barcode: cleaned, format };
  }

  if (format === 'ean13') {
    if (!DIGITS_ONLY_REGEX.test(cleaned) || cleaned.length !== 13) {
      throw new DomainError('INVALID_BARCODE', 'EAN-13 barcode must contain exactly 13 digits');
    }
    if (!verifyGs1CheckDigit(cleaned)) {
      throw new DomainError('INVALID_BARCODE_CHECK_DIGIT', 'Invalid EAN-13 GS1 check digit');
    }
    return { barcode: cleaned, format: 'ean13' };
  }

  if (format === 'upca') {
    if (!DIGITS_ONLY_REGEX.test(cleaned) || cleaned.length !== 12) {
      throw new DomainError('INVALID_BARCODE', 'UPC-A barcode must contain exactly 12 digits');
    }
    if (!verifyGs1CheckDigit(cleaned)) {
      throw new DomainError('INVALID_BARCODE_CHECK_DIGIT', 'Invalid UPC-A GS1 check digit');
    }
    return { barcode: `0${cleaned}`, format: 'upca' };
  }

  // format === 'ean8'
  if (!DIGITS_ONLY_REGEX.test(cleaned) || cleaned.length !== 8) {
    throw new DomainError('INVALID_BARCODE', 'EAN-8 barcode must contain exactly 8 digits');
  }
  if (!verifyGs1CheckDigit(cleaned)) {
    throw new DomainError('INVALID_BARCODE_CHECK_DIGIT', 'Invalid EAN-8 GS1 check digit');
  }
  return { barcode: cleaned, format: 'ean8' };
}

/**
 * Produces ordered scan lookup candidates so 12-digit UPC-A scans resolve the canonical 13-digit
 * (`'0' + code`) record seamlessly while still finding explicitly registered `'internal'` 12-digit codes.
 */
export function buildScanBarcodeCandidates(rawBarcode: string): readonly string[] {
  const cleaned = normalizeBarcodeInput(rawBarcode);
  if (DIGITS_ONLY_REGEX.test(cleaned) && cleaned.length === 12) {
    return [`0${cleaned}`, cleaned];
  }
  return [cleaned];
}

export interface CanonicalVariantAttributes {
  readonly attributes: Readonly<Record<string, string>>;
  readonly json: string;
}

export function canonicalizeVariantAttributes(
  input: Readonly<Record<string, string>>,
): CanonicalVariantAttributes {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DomainError('VALIDATION_ERROR', 'Variant attributes must be a plain object');
  }

  const entries = Object.entries(input);
  if (entries.length > MAX_VARIANT_ATTRIBUTE_KEYS) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `Variant attributes may contain at most ${String(MAX_VARIANT_ATTRIBUTE_KEYS)} keys`,
    );
  }

  const cleanMap = new Map<string, string>();
  for (const [rawKey, rawValue] of entries) {
    if (typeof rawValue !== 'string') {
      throw new DomainError('VALIDATION_ERROR', 'Variant attribute values must be strings');
    }
    const cleanKey = normalizeCatalogDisplayName(rawKey, 'Attribute key', 64);
    const cleanVal = normalizeCatalogDisplayName(rawValue, 'Attribute value', 128);
    if (cleanMap.has(cleanKey)) {
      throw new DomainError('VALIDATION_ERROR', `Duplicate variant attribute key "${cleanKey}"`);
    }
    cleanMap.set(cleanKey, cleanVal);
  }

  const sortedKeys = [...cleanMap.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const sortedObj: Record<string, string> = {};
  for (const key of sortedKeys) {
    const val = cleanMap.get(key);
    if (val !== undefined) {
      sortedObj[key] = val;
    }
  }

  return {
    attributes: sortedObj,
    json: JSON.stringify(sortedObj),
  };
}

export function parseVariantAttributesJson(json: string): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DomainError('VALIDATION_ERROR', 'Stored variant attributes JSON is malformed');
  }
  const record: Record<string, string> = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val !== 'string') {
      throw new DomainError('VALIDATION_ERROR', 'Stored variant attribute value must be a string');
    }
    record[key] = val;
  }
  return record;
}
