import { afterEach, describe, expect, it } from 'vitest';
import {
  type I18nKey,
  RU_MESSAGES,
  SUPPORTED_LOCALES,
  UZ_LATN_MESSAGES,
  getLocale,
  getMessages,
  isLocale,
  latnToCyrl,
  setLocale,
  t,
} from './index.js';

const KEYS = Object.keys(UZ_LATN_MESSAGES) as I18nKey[];

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();
}

afterEach(() => {
  setLocale('uz-Latn');
});

describe('@mezon/i18n — Uzbek Latin POS dictionary', () => {
  it('interpolates parameters and keeps non-fiscal banner exact', () => {
    expect(t('receipt.nonFiscalBanner')).toBe('FISKAL EMAS');
    expect(t('auth.rateLimited', { seconds: 42 })).toBe(
      'Koʻp xato urinish! 42 soniyadan keyin qayta urining.',
    );
    expect(KEYS.length).toBeGreaterThan(80);
  });
});

describe('T4.6 locales', () => {
  it('every locale has every key, a non-empty text and exactly the same placeholders', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const dict = getMessages(locale);
      expect(Object.keys(dict).sort()).toEqual([...KEYS].sort());
      for (const key of KEYS) {
        const text = dict[key];
        expect(text.trim().length, `${locale} ${key}`).toBeGreaterThan(0);
        expect(placeholders(text), `${locale} ${key}`).toEqual(placeholders(UZ_LATN_MESSAGES[key]));
      }
    }
  });

  it('Russian texts are actually Russian (Cyrillic) unless the source is a symbol or brand', () => {
    const latinOnly = KEYS.filter((k) => {
      const src = UZ_LATN_MESSAGES[k].replace(/\{\w+\}/g, '');
      const ru = RU_MESSAGES[k];
      return /[a-z]{3,}/i.test(src) && !/[а-яё]/i.test(ru);
    });
    // Brand-only / provider-only labels legitimately stay Latin.
    expect(latinOnly.sort()).toEqual(
      [
        'admin.telegram.title',
        'payment.method.click',
        'payment.method.payme',
        'payment.method.uzqr',
        'payment.method.uzum',
      ].sort(),
    );
  });

  it('Cyrillic dictionary contains no Uzbek Latin letters except protected tokens', () => {
    const cyrl = getMessages('uz-Cyrl');
    for (const key of KEYS) {
      const leftover = cyrl[key]
        .replace(/\{\w+\}/g, '')
        .replace(
          /\b(F\d{1,2}|Enter|Esc|Delete|SKU|UzQR|Payme|Click|Uzum|Humo|Uzcard|Hub|Renderer|Mezon|Guzar|Telegram|Owner|Manager|username|cash_in|cash_out|C)\b/g,
          '',
        )
        .replace(/\/health/g, '')
        .replace(/\/[a-z]+/g, '');
      expect(/[A-Za-z]/.test(leftover), `${key}: ${cyrl[key]}`).toBe(false);
    }
  });

  it('setLocale switches t(), rejects unknown locales, and explicit locale argument wins', () => {
    expect(getLocale()).toBe('uz-Latn');
    setLocale('ru');
    expect(t('common.save')).toBe('Сохранить');
    expect(t('auth.rateLimited', { seconds: 5 })).toContain('5');
    setLocale('uz-Cyrl');
    expect(t('common.save')).toBe('Сақлаш');
    expect(t('common.save', undefined, 'uz-Latn')).toBe('Saqlash');
    expect(() => setLocale('en' as never)).toThrow();
    expect(isLocale('ru')).toBe(true);
    expect(isLocale('en')).toBe(false);
  });
});

describe('T4.6 Latin → Cyrillic transliteration', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['Koʻp xato urinish!', 'Кўп хато уриниш!'],
    ["O'chirish", 'Ўчириш'],
    ["so'm", 'сўм'],
    ['yoʻq', 'йўқ'],
    ['Savat boʻsh.', 'Сават бўш.'],
    ['Eslatma', 'Эслатма'],
    ['yetarli emas', 'етарли эмас'],
    ['Shtrix-kodni skanerlang', 'Штрих-кодни сканерланг'],
    ['Boshlangʻich naqd pul', 'Бошланғич нақд пул'],
    ['Yangi mahsulot', 'Янги маҳсулот'],
    ['Yuklanmoqda...', 'Юкланмоқда...'],
    ['QQS stavkasi', 'ҚҚС ставкаси'],
    ['STIR', 'СТИР'],
    ['MXIKʼsiz ({count})', 'МХИКсиз ({count})'],
    ['{seconds} soniyadan keyin', '{seconds} сониядан кейин'],
    ['F2 — Qidiruv', 'F2 — Қидирув'],
    ['Savdoni yakunlash (Enter)', 'Савдони якунлаш (Enter)'],
    ['Bank kartasi (Humo/Uzcard)', 'Банк картаси (Humo/Uzcard)'],
    ['taʼmir', 'таъмир'],
    ['FISKAL EMAS', 'ФИСКАЛ ЭМАС'],
    ['Choy', 'Чой'],
  ];
  for (const [latn, cyrl] of cases) {
    it(`${latn} → ${cyrl}`, () => {
      expect(latnToCyrl(latn)).toBe(cyrl);
    });
  }

  it('is idempotent on already-Cyrillic text and keeps digits, symbols and placeholders', () => {
    expect(latnToCyrl('Кўп 12 345 сўм')).toBe('Кўп 12 345 сўм');
    expect(latnToCyrl('{oldTotal} -> {newTotal}')).toBe('{oldTotal} -> {newTotal}');
    expect(latnToCyrl('↑ / ↓ — +998901234567')).toBe('↑ / ↓ — +998901234567');
  });
});
