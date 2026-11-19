import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setLocale } from '@mezon/i18n';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminApiError } from './api-client.js';
import {
  describeApiError,
  formatQty,
  formatSom,
  parseSomToTiyin,
  paymentMethodLabel,
  tashkentDateKey,
  unitLabel,
} from './utils/format.js';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(p);
    return e.name.endsWith('.tsx') ? [p] : [];
  });
}

describe('@mezon/admin - T2.7a R3 localisation', () => {
  afterEach(() => setLocale('uz-Latn'));

  it('no hardcoded words in JSX text or string attributes of the cabinet UI', () => {
    // Allowed literal text: the brand and the SKU label (protected tokens in @mezon/i18n).
    const allowed = /^(Guzar|SKU:)$/;
    const offenders: string[] = [];
    for (const file of tsxFiles(srcDir)) {
      const src = fs.readFileSync(file, 'utf8');
      // Inline JSX text: `>Some words<` on one line, no code characters.
      for (const m of src.matchAll(/>([^<>{}\n;=()[\]]*\p{L}{2,}[^<>{}\n;=()[\]]*)</gu)) {
        const text = m[1]?.trim() ?? '';
        if (text && !allowed.test(text)) offenders.push(`${path.basename(file)}: ${text}`);
      }
      // JSX text on its own line right after an opening tag.
      const lines = src.split('\n');
      for (let i = 1; i < lines.length; i += 1) {
        const text = lines[i]?.trim() ?? '';
        const prev = lines[i - 1]?.trim() ?? '';
        if (
          prev.endsWith('>') &&
          !prev.endsWith('=>') &&
          /^[\p{L}\s.,:!?'’ʻ—-]*\p{L}{2,}[\p{L}\s.,:!?'’ʻ—-]*$/u.test(text) &&
          !allowed.test(text)
        ) {
          offenders.push(`${path.basename(file)}: ${text}`);
        }
      }
      for (const m of src.matchAll(/(placeholder|aria-label|title)="([^"]+)"/g)) {
        offenders.push(`${path.basename(file)}: ${m[1]}="${m[2]}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('money keeps the sign and the localized currency word (old helper printed -50 tiyin as 0.50)', () => {
    expect(formatSom('-50')).toBe("-0.50 so'm");
    expect(formatSom('125000000')).toBe("1 250 000 so'm");
    expect(formatSom('-12345')).toBe("-123.45 so'm");
    expect(formatSom(null)).toBe('—');
    setLocale('ru');
    expect(formatSom('100')).toBe('1 сум');
  });

  it('report day is the Tashkent day, not the UTC day', () => {
    // 2026-11-16 20:30 UTC = 2026-11-17 01:30 in Tashkent.
    expect(tashkentDateKey(Date.UTC(2026, 10, 16, 20, 30))).toBe('2026-11-17');
    // 2026-11-16 18:59 UTC = 23:59 Tashkent, still the 16th.
    expect(tashkentDateKey(Date.UTC(2026, 10, 16, 18, 59))).toBe('2026-11-16');
  });

  it('quantities, units and payment methods are formatted without floats and localized', () => {
    expect(formatQty('1500')).toBe('1.5');
    expect(formatQty('1000')).toBe('1');
    expect(unitLabel('kg')).toBe('kg');
    expect(unitLabel('unknown-unit')).toBe('unknown-unit');
    expect(paymentMethodLabel('cash')).toBe('Naqd pul');
    setLocale('ru');
    expect(paymentMethodLabel('cash')).not.toBe('Naqd pul');
    expect(paymentMethodLabel('weird')).toBe('weird');
  });

  it('API errors become localized messages', () => {
    expect(describeApiError(new AdminApiError(403, 'Forbidden'))).toContain('Kassir');
    expect(describeApiError(new AdminApiError(500, 'boom'))).toBe("Ma'lumotlarni yuklab bo'lmadi");
    setLocale('ru');
    expect(describeApiError(new Error('x'))).toBe('Не удалось загрузить данные');
  });

  it('T2.7b: a typed price in som becomes exact tiyin; anything else is refused', () => {
    expect(parseSomToTiyin('12500')).toBe('1250000');
    expect(parseSomToTiyin('12 500')).toBe('1250000');
    expect(parseSomToTiyin('12500.5')).toBe('1250050');
    expect(parseSomToTiyin('12500,05')).toBe('1250005');
    expect(parseSomToTiyin('0')).toBe('0');
    for (const bad of ['', '-1', '1.234', 'abc', '1e5', '12.', '.5', '99999999999999']) {
      expect(parseSomToTiyin(bad), bad).toBeNull();
    }
  });
});
