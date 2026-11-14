import type { PrinterPaperWidthMm } from './types.js';

export function getPaperWidthColumns(paperWidthMm: PrinterPaperWidthMm): 32 | 48 {
  return paperWidthMm === 58 ? 32 : 48;
}

export function formatTiyinAmount(tiyin: bigint): string {
  const isNegative = tiyin < 0n;
  const abs = isNegative ? -tiyin : tiyin;
  const wholeSom = abs / 100n;
  const remTiyin = abs % 100n;

  const digits = wholeSom.toString();
  let grouped = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) {
      grouped += ' ';
    }
    grouped += digits[i];
  }

  const decimalPart = remTiyin === 0n ? '' : `.${remTiyin.toString().padStart(2, '0')}`;
  return `${isNegative ? '-' : ''}${grouped}${decimalPart}`;
}

export function formatMilliQty(milli: bigint): string {
  const isNegative = milli < 0n;
  const abs = isNegative ? -milli : milli;
  const whole = abs / 1000n;
  const rem = abs % 1000n;
  if (rem === 0n) {
    return `${isNegative ? '-' : ''}${whole.toString()}`;
  }
  const frac = rem.toString().padStart(3, '0').replace(/0+$/, '');
  return `${isNegative ? '-' : ''}${whole.toString()}.${frac}`;
}

export function formatVatRatePercent(vatRateBp: number): string {
  const whole = Math.trunc(vatRateBp / 100);
  const rem = Math.abs(vatRateBp % 100);
  if (rem === 0) {
    return `${String(whole)}%`;
  }
  return `${String(whole)}.${String(rem).padStart(2, '0').replace(/0+$/, '')}%`;
}

export function centerLine(text: string, width: number): string {
  const trimmed = text.trim();
  if (trimmed.length >= width) {
    return trimmed.slice(0, width);
  }
  const leftPad = Math.floor((width - trimmed.length) / 2);
  return ' '.repeat(leftPad) + trimmed;
}

export function repeatDivider(char: '-' | '=', width: number): string {
  return char.repeat(width);
}

/**
 * Wraps a text string across multiple lines of at most `width` characters,
 * breaking at word boundaries where possible and hard-splitting single words longer than `width`.
 */
export function wrapTextLines(text: string, width: number, indent = ''): readonly string[] {
  const clean = text.trim();
  if (clean.length === 0) {
    return [''];
  }
  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const prefix = lines.length === 0 ? '' : indent;
    const maxLen = width - prefix.length;

    if (current.length === 0) {
      if (word.length <= maxLen) {
        current = prefix + word;
      } else {
        let offset = 0;
        while (offset < word.length) {
          const linePrefix = lines.length === 0 && offset === 0 ? '' : indent;
          const chunkMax = Math.max(1, width - linePrefix.length);
          const chunk = word.slice(offset, offset + chunkMax);
          offset += chunkMax;
          if (offset < word.length) {
            lines.push(linePrefix + chunk);
          } else {
            current = linePrefix + chunk;
          }
        }
      }
      continue;
    }

    if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      if (indent.length + word.length <= width) {
        current = indent + word;
      } else {
        let offset = 0;
        current = '';
        while (offset < word.length) {
          const chunkMax = Math.max(1, width - indent.length);
          const chunk = word.slice(offset, offset + chunkMax);
          offset += chunkMax;
          if (offset < word.length) {
            lines.push(indent + chunk);
          } else {
            current = indent + chunk;
          }
        }
      }
    }
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines;
}

/**
 * Formats a left-aligned label and right-aligned value into a single line (or two lines if they exceed `width`).
 */
export function formatKeyValueRows(left: string, right: string, width: number): readonly string[] {
  const minGap = 1;
  if (left.length + minGap + right.length <= width) {
    const spaces = width - left.length - right.length;
    return [`${left}${' '.repeat(spaces)}${right}`];
  }
  const wrappedLeft = wrapTextLines(left, width);
  const lastLine = wrappedLeft[wrappedLeft.length - 1] ?? '';
  if (lastLine.length + minGap + right.length <= width) {
    const spaces = width - lastLine.length - right.length;
    return [...wrappedLeft.slice(0, -1), `${lastLine}${' '.repeat(spaces)}${right}`];
  }
  const rightAligned =
    right.length >= width ? right.slice(0, width) : `${' '.repeat(width - right.length)}${right}`;
  return [...wrappedLeft, rightAligned];
}
