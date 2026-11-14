import type { PrinterEncodingMode } from './types.js';

/**
 * ESC/POS `ESC t n` code page table numbers:
 * - `0`: PC437 (Standard USA / ASCII — universal across all thermal printers)
 * - `17`: PC866 (Cyrillic #2 — standard on CIS thermal printers)
 * - `73`: Windows-1251 (Cyrillic)
 */
export function getEscPosCodePageNumber(encoding: PrinterEncodingMode): number {
  switch (encoding) {
    case 'translit':
      return 0;
    case 'cp866':
      return 17;
    case 'cp1251':
      return 73;
  }
}

const UZBEK_APOSTROPHE_REGEX = /[\u02BB\u02BC\u2018\u2019\u0060\u00B4]/g;
const DASH_REGEX = /[\u2013\u2014\u2212]/g;
const NBSP_REGEX = /[\u00A0\u202F]/g;

const CYRILLIC_TO_LATIN_MAP: Readonly<Record<string, string>> = {
  А: 'A',
  а: 'a',
  Б: 'B',
  б: 'b',
  В: 'V',
  в: 'v',
  Г: 'G',
  г: 'g',
  Ғ: "G'",
  ғ: "g'",
  Д: 'D',
  д: 'd',
  Е: 'E',
  е: 'e',
  Ё: 'Yo',
  ё: 'yo',
  Ж: 'J',
  ж: 'j',
  З: 'Z',
  з: 'z',
  И: 'I',
  и: 'i',
  Й: 'Y',
  й: 'y',
  К: 'K',
  к: 'k',
  Қ: 'Q',
  қ: 'q',
  Л: 'L',
  л: 'l',
  М: 'M',
  м: 'm',
  Н: 'N',
  н: 'n',
  О: 'O',
  о: 'o',
  П: 'P',
  п: 'p',
  Р: 'R',
  р: 'r',
  С: 'S',
  с: 's',
  Т: 'T',
  т: 't',
  У: 'U',
  у: 'u',
  Ў: "O'",
  ў: "o'",
  Ф: 'F',
  ф: 'f',
  Х: 'X',
  х: 'x',
  Ҳ: 'H',
  ҳ: 'h',
  Ц: 'Ts',
  ц: 'ts',
  Ч: 'Ch',
  ч: 'ch',
  Ш: 'Sh',
  ш: 'sh',
  Щ: 'Sh',
  щ: 'sh',
  Ъ: "'",
  ъ: "'",
  Ы: 'I',
  ы: 'i',
  Ь: '',
  ь: '',
  Э: 'E',
  э: 'e',
  Ю: 'Yu',
  ю: 'yu',
  Я: 'Ya',
  я: 'ya',
  '\u2116': 'No',
};

/**
 * Normalizes Uzbek typographic characters (`oʻ`, `gʻ`, `ʼ`, em-dashes, non-breaking spaces)
 * into clean printable characters.
 */
export function normalizeUzbekTypography(input: string): string {
  return input
    .replace(UZBEK_APOSTROPHE_REGEX, "'")
    .replace(DASH_REGEX, '-')
    .replace(NBSP_REGEX, ' ');
}

/**
 * Transliterates Uzbek Latin & Cyrillic text into pure 7-bit printable ASCII (`0x20..0x7E`).
 */
export function transliterateToAscii(input: string): string {
  const normalized = normalizeUzbekTypography(input);
  let out = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    const mapped = CYRILLIC_TO_LATIN_MAP[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) {
      out += ch;
    } else if (ch === '\n' || ch === '\r') {
      out += ch;
    } else {
      out += '?';
    }
  }
  return out;
}

/**
 * Converts a single character (after Uzbek typography normalization) into its CP866 byte (`0x00..0xFF`).
 * Extended Uzbek Cyrillic letters not in standard CP866 (`Қ`, `Ғ`, `Ҳ`, `Ў`) map to their base Cyrillic equivalents
 * (`К`, `Г`, `Х`, `У`) so thermal printers never print `?` for Uzbek Cyrillic product names.
 */
function charToCp866Byte(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 0x20 && code <= 0x7e) {
    return code;
  }
  // Map Uzbek-specific Cyrillic to standard Cyrillic before CP866 encoding
  switch (ch) {
    case 'Қ':
      return 0x8a; // 'К'
    case 'қ':
      return 0xaa; // 'к'
    case 'Ғ':
      return 0x83; // 'Г'
    case 'ғ':
      return 0xa3; // 'г'
    case 'Ҳ':
      return 0x95; // 'Х'
    case 'ҳ':
      return 0xe5; // 'х'
    case 'Ў':
      return 0x93; // 'У'
    case 'ў':
      return 0xe3; // 'у'
    case 'Ё':
      return 0xf0;
    case 'ё':
      return 0xf1;
    case '№':
      return 0xfc;
  }
  // 'А' (U+0410) .. 'Я' (U+042F) -> 0x80..0x9F
  if (code >= 0x0410 && code <= 0x042f) {
    return 0x80 + (code - 0x0410);
  }
  // 'а' (U+0430) .. 'п' (U+043F) -> 0xA0..0xAF
  if (code >= 0x0430 && code <= 0x043f) {
    return 0xa0 + (code - 0x0430);
  }
  // 'р' (U+0440) .. 'я' (U+044F) -> 0xE0..0xEF
  if (code >= 0x0440 && code <= 0x044f) {
    return 0xe0 + (code - 0x0440);
  }
  return 0x3f; // '?'
}

/**
 * Converts a single character (after Uzbek typography normalization) into its Windows-1251 byte (`0x00..0xFF`).
 */
function charToCp1251Byte(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 0x20 && code <= 0x7e) {
    return code;
  }
  switch (ch) {
    case 'Қ':
      return 0xca; // 'К'
    case 'қ':
      return 0xea; // 'к'
    case 'Ғ':
      return 0xc3; // 'Г'
    case 'ғ':
      return 0xe3; // 'г'
    case 'Ҳ':
      return 0xd5; // 'Х'
    case 'ҳ':
      return 0xf5; // 'х'
    case 'Ў':
      return 0xd3; // 'У'
    case 'ў':
      return 0xf3; // 'у'
    case 'Ё':
      return 0xa8;
    case 'ё':
      return 0xb8;
    case '№':
      return 0xb9;
  }
  // 'А' (U+0410) .. 'я' (U+044F) -> 0xC0..0xFF
  if (code >= 0x0410 && code <= 0x044f) {
    return 0xc0 + (code - 0x0410);
  }
  return 0x3f; // '?'
}

/**
 * Normalizes a text line for the selected encoding mode so line wrapping and column alignment
 * operate on the exact 1-byte-per-character string that will be sent to the printer.
 */
export function normalizeTextForEncoding(text: string, encoding: PrinterEncodingMode): string {
  if (encoding === 'translit') {
    return transliterateToAscii(text);
  }
  return normalizeUzbekTypography(text);
}

/**
 * Encodes a single normalized line of text (without trailing newline) into single-byte codes
 * for the selected ESC/POS codepage.
 */
export function encodeLineBytes(normalizedLine: string, encoding: PrinterEncodingMode): Uint8Array {
  if (encoding === 'translit') {
    const ascii = transliterateToAscii(normalizedLine);
    const bytes = new Uint8Array(ascii.length);
    for (let i = 0; i < ascii.length; i += 1) {
      const code = ascii.charCodeAt(i);
      bytes[i] = code >= 0x20 && code <= 0x7e ? code : 0x3f;
    }
    return bytes;
  }

  const bytes = new Uint8Array(normalizedLine.length);
  for (let i = 0; i < normalizedLine.length; i += 1) {
    const ch = normalizedLine[i];
    bytes[i] = encoding === 'cp866' ? charToCp866Byte(ch) : charToCp1251Byte(ch);
  }
  return bytes;
}
