/**
 * T4.6: deterministic Uzbek Latin → Uzbek Cyrillic transliteration.
 *
 * The Cyrillic dictionary is derived from the Latin one at runtime, so every key added later in
 * Latin is covered automatically. Rules follow the official 1995 Latin alphabet mapping:
 * digraphs (sh, ch, oʻ, gʻ, yo, yu, ya, ye) first, `e` → `э` at a word start or after a vowel,
 * the modifier/ASCII apostrophe after `o`/`g` forms oʻ/gʻ and elsewhere becomes `ъ` (tutuq belgisi).
 *
 * Interpolation tokens (`{name}`), brand names and technical tokens (F-keys, Enter, payment
 * providers, codes with digits or underscores) are kept verbatim.
 */

const APOSTROPHES = new Set(["'", 'ʻ', 'ʼ', '‘', '’', '`']);
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'а', 'е', 'и', 'о', 'у', 'э', 'ў', 'ё', 'ю', 'я']);

/** Tokens that are never transliterated (brands, keys, providers, protocol words). */
const PROTECTED_WORDS = new Set([
  'Enter',
  'Esc',
  'Delete',
  'Backspace',
  'SKU',
  'UzQR',
  'Payme',
  'Click',
  'Uzum',
  'Humo',
  'Uzcard',
  'Hub',
  'Renderer',
  'Mezon',
  'Guzar',
  'Telegram',
  'Owner',
  'Manager',
  'username',
]);

const SINGLE: Readonly<Record<string, string>> = {
  a: 'а',
  b: 'б',
  d: 'д',
  f: 'ф',
  g: 'г',
  h: 'ҳ',
  i: 'и',
  j: 'ж',
  k: 'к',
  l: 'л',
  m: 'м',
  n: 'н',
  o: 'о',
  p: 'п',
  q: 'қ',
  r: 'р',
  s: 'с',
  t: 'т',
  u: 'у',
  v: 'в',
  x: 'х',
  y: 'й',
  z: 'з',
  c: 'с',
  w: 'в',
};

function isUpper(ch: string): boolean {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

function applyCase(cyr: string, first: string, second: string | undefined): string {
  if (!isUpper(first)) return cyr;
  // "SH" in an all-caps word → "Ш"; "Sh" at a capitalised word start → "Ш" as well.
  if (second === undefined || isUpper(second) || cyr.length === 1) return cyr.toUpperCase();
  return cyr.charAt(0).toUpperCase() + cyr.slice(1);
}

function isLatinLetter(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z]/.test(ch);
}

function transliterateWord(word: string): string {
  if (PROTECTED_WORDS.has(word)) return word;
  // Function keys (F1..F12), anything with digits, underscores or slashes stays as is.
  if (/^F\d{1,2}$/.test(word) || /[\d_/]/.test(word)) return word;

  let out = '';
  let i = 0;
  const lower = word.toLowerCase();
  while (i < word.length) {
    const ch = word.charAt(i);
    const lc = lower.charAt(i);
    const next = lower.charAt(i + 1);
    const next2 = word.charAt(i + 2);

    if (!isLatinLetter(ch)) {
      if (APOSTROPHES.has(ch)) {
        // Apostrophe not consumed by oʻ/gʻ: tutuq belgisi → ъ, but drop it after an all-caps
        // acronym ("MXIKʼsiz" → "МХИКсиз") and at word edges.
        const prev = word.charAt(i - 1);
        const after = word.charAt(i + 1);
        const prevIsUpperAcronym = i >= 2 && isUpper(prev) && isUpper(word.charAt(i - 2));
        if (isLatinLetter(prev) && isLatinLetter(after) && !prevIsUpperAcronym) {
          out += 'ъ';
        }
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    // oʻ / gʻ (any apostrophe variant)
    if ((lc === 'o' || lc === 'g') && APOSTROPHES.has(word.charAt(i + 1))) {
      const cyr = lc === 'o' ? 'ў' : 'ғ';
      out += isUpper(ch) ? cyr.toUpperCase() : cyr;
      i += 2;
      continue;
    }
    // sh, ch
    if ((lc === 's' || lc === 'c') && next === 'h') {
      out += applyCase(lc === 's' ? 'ш' : 'ч', ch, word.charAt(i + 1));
      i += 2;
      continue;
    }
    // yo, yu, ya, ye — but "yoʻ" is y + oʻ ("yoʻq" → "йўқ")
    if (lc === 'y' && (next === 'o' || next === 'u' || next === 'a' || next === 'e')) {
      if (!(next === 'o' && APOSTROPHES.has(next2))) {
        const map: Readonly<Record<string, string>> = { o: 'ё', u: 'ю', a: 'я', e: 'е' };
        out += applyCase(map[next] ?? '', ch, word.charAt(i + 1));
        i += 2;
        continue;
      }
    }
    if (lc === 'e') {
      const prevOut = out.charAt(out.length - 1).toLowerCase();
      const atStart = out.length === 0 || !/[а-яёўқғҳъ]/i.test(prevOut);
      const cyr = atStart || VOWELS.has(prevOut) ? 'э' : 'е';
      out += isUpper(ch) ? cyr.toUpperCase() : cyr;
      i += 1;
      continue;
    }
    const cyr = SINGLE[lc] ?? ch;
    out += isUpper(ch) ? cyr.toUpperCase() : cyr;
    i += 1;
  }
  return out;
}

/** Transliterates a whole message, keeping `{placeholders}` verbatim. */
export function latnToCyrl(text: string): string {
  return text
    .split(/(\{\w+\})/)
    .map((part) => {
      if (/^\{\w+\}$/.test(part)) return part;
      // Words are runs of Latin letters plus inner apostrophes; everything else passes through.
      return part.replace(/[A-Za-z0-9_/]+(?:['ʻʼ‘’`][A-Za-z]+)*/g, (w) => transliterateWord(w));
    })
    .join('');
}
