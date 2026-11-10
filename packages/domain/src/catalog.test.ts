import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BARCODE_FORMATS,
  DomainError,
  PRODUCT_UNITS,
  buildFtsPrefixQuery,
  buildScanBarcodeCandidates,
  canonicalizeVariantAttributes,
  computeGs1CheckDigit,
  isIntegerOnlyUnit,
  isProductUnit,
  moneyFromTiyin,
  normalizeBarcodeInput,
  normalizeCatalogDisplayName,
  normalizeCatalogSearchText,
  normalizeCatalogSku,
  normalizeFiscalCode,
  normalizePriceChangeReason,
  parseProductUnit,
  parseVariantAttributesJson,
  prepareBarcodeForStorage,
  quantityFromMilli,
  tokenizeCatalogSearchQuery,
  validateNonNegativeSalePrice,
  validateQuantityForUnit,
  verifyGs1CheckDigit,
} from './index.js';

describe('@mezon/domain - catalog units, barcodes, transliteration, and attributes', () => {
  it('validates units and enforces integer multiples on dona/qadoq with property tests', () => {
    expect(PRODUCT_UNITS).toEqual(['dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq']);
    expect(isProductUnit('kg')).toBe(true);
    expect(isProductUnit('tonna')).toBe(false);
    expect(parseProductUnit('qadoq')).toBe('qadoq');
    expect(() => parseProductUnit('piece')).toThrow(DomainError);

    expect(isIntegerOnlyUnit('dona')).toBe(true);
    expect(isIntegerOnlyUnit('qadoq')).toBe(true);
    expect(isIntegerOnlyUnit('kg')).toBe(false);

    // 5.5 kg -> 5500n milli valid
    expect(validateQuantityForUnit('kg', quantityFromMilli(5_500n))).toBe(
      quantityFromMilli(5_500n),
    );
    // 1.5 dona -> invalid
    expect(() => validateQuantityForUnit('dona', quantityFromMilli(1_500n))).toThrow(DomainError);
    expect(() => validateQuantityForUnit('qadoq', quantityFromMilli(250n))).toThrow(DomainError);
    // 0 allowed only with allowZero
    expect(() => validateQuantityForUnit('dona', quantityFromMilli(0n))).toThrow(DomainError);
    expect(validateQuantityForUnit('dona', quantityFromMilli(0n), { allowZero: true })).toBe(
      quantityFromMilli(0n),
    );
    expect(() =>
      validateQuantityForUnit('kg', quantityFromMilli(-1n), { allowZero: true }),
    ).toThrow(DomainError);

    fc.assert(
      fc.property(
        fc.constantFrom<'dona' | 'qadoq'>('dona', 'qadoq'),
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        fc.bigInt({ min: 1n, max: 999n }),
        (unit, whole, rem) => {
          const valid = quantityFromMilli(whole * 1000n);
          const fractional = quantityFromMilli(whole * 1000n + rem);
          if (whole > 0n) {
            expect(validateQuantityForUnit(unit, valid)).toBe(valid);
          }
          expect(validateQuantityForUnit(unit, valid, { allowZero: true })).toBe(valid);
          expect(() => validateQuantityForUnit(unit, fractional)).toThrow(DomainError);
        },
      ),
    );

    fc.assert(
      fc.property(
        fc.constantFrom<'kg' | 'g' | 'litr' | 'metr' | 'm2'>('kg', 'g', 'litr', 'metr', 'm2'),
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        (unit, milli) => {
          const q = quantityFromMilli(milli);
          expect(validateQuantityForUnit(unit, q)).toBe(q);
        },
      ),
    );
  });

  it('validates prices, names, SKUs, and fiscal strings safely', () => {
    expect(validateNonNegativeSalePrice(moneyFromTiyin(0n))).toBe(moneyFromTiyin(0n));
    expect(validateNonNegativeSalePrice(moneyFromTiyin(150_000n))).toBe(moneyFromTiyin(150_000n));
    expect(() => validateNonNegativeSalePrice(moneyFromTiyin(-1n))).toThrow(DomainError);

    expect(normalizeCatalogDisplayName('  Olma   sharbat  1L ')).toBe('Olma sharbat 1L');
    expect(() => normalizeCatalogDisplayName('   ')).toThrow(DomainError);
    expect(() => normalizeCatalogDisplayName('bad\x07name')).toThrow(DomainError);

    expect(normalizeCatalogSku(null)).toBeNull();
    expect(normalizeCatalogSku('  SKU-100 ')).toBe('SKU-100');
    expect(() => normalizeCatalogSku('   ')).toThrow(DomainError);

    expect(normalizeFiscalCode(undefined, 'MXIK')).toBeNull();
    expect(normalizeFiscalCode('   ', 'MXIK')).toBeNull();
    expect(normalizeFiscalCode(' 01023001001000001 ', 'MXIK')).toBe('01023001001000001');
    expect(() => normalizeFiscalCode('bad mxik', 'MXIK')).toThrow(DomainError);

    expect(normalizePriceChangeReason('  ')).toBeNull();
    expect(normalizePriceChangeReason('  Yangi   kirim  ')).toBe('Yangi kirim');
  });

  it('F5: transliterates Uzbek Cyrillic and strips apostrophes/hard/soft signs accurately', () => {
    expect(normalizeCatalogSearchText('хона')).toBe('xona');
    expect(normalizeCatalogSearchText('ҳаво')).toBe('havo');
    expect(normalizeCatalogSearchText('маъно')).toBe('mano');
    expect(normalizeCatalogSearchText('Молоко')).toBe('moloko');
    expect(normalizeCatalogSearchText('Coca-Cola Zero')).toBe('coca cola zero');
    expect(tokenizeCatalogSearchQuery('Coca-Cola Zero')).toContain('zero');

    expect(normalizeCatalogSearchText("O'rik")).toBe('orik');
    expect(normalizeCatalogSearchText('oʻrik')).toBe('orik');
    expect(normalizeCatalogSearchText('ўрик')).toBe('orik');
    expect(normalizeCatalogSearchText("G'ijduvon")).toBe('gijduvon');
    expect(normalizeCatalogSearchText('Ғиждувон')).toBe('gijduvon');
    expect(normalizeCatalogSearchText('Қалампир')).toBe('qalampir');
    expect(normalizeCatalogSearchText('Печенье')).toBe('pechenye');
    expect(normalizeCatalogSearchText('Ерёнғоқ')).toBe('yeryongoq');
    expect(normalizeCatalogSearchText('Акция')).toBe('aksiya');
    expect(normalizeCatalogSearchText('Медицина')).toBe('meditsina');
  });

  it('F2: sanitizes FTS5 queries so operators and punctuation cannot inject or throw', () => {
    const emptyInjectionInputs = ['"', '*', '-', ':', '(', ')', '""', '-*:( )', '   ', '///'];
    for (const raw of emptyInjectionInputs) {
      expect(buildFtsPrefixQuery(raw)).toBeNull();
    }

    expect(buildFtsPrefixQuery('NEAR')).toBe('"near"*');
    expect(buildFtsPrefixQuery('OR')).toBe('"or"*');
    expect(buildFtsPrefixQuery('AND')).toBe('"and"*');
    expect(buildFtsPrefixQuery('NOT')).toBe('"not"*');
    expect(buildFtsPrefixQuery('cola OR pepsi -zero* : "mini" (1)')).toBe(
      '"cola"* AND "or"* AND "pepsi"* AND "zero"* AND "mini"* AND "1"*',
    );
    expect(buildFtsPrefixQuery('хОна')).toBe('"xona"*');
    expect(buildFtsPrefixQuery('ҳАвО')).toBe('"havo"*');

    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (raw) => {
        const expr = buildFtsPrefixQuery(raw);
        if (expr !== null) {
          expect(expr).toMatch(/^"[a-z0-9]+"\*( AND "[a-z0-9]+"\*)*$/);
        }
      }),
    );
  });

  it('F3 & GS1: verifies GS1 check digits, canonicalizes UPC-A to 13 digits, and detects single-digit corruption', () => {
    expect(BARCODE_FORMATS).toEqual(['ean13', 'ean8', 'upca', 'internal', 'other']);
    expect(normalizeBarcodeInput(' 460 7001791234 \r\n')).toBe('4607001791234');
    expect(() => normalizeBarcodeInput('   ')).toThrow(DomainError);
    expect(() => normalizeBarcodeInput('460700$123')).toThrow(DomainError);

    expect(verifyGs1CheckDigit('4006381333931')).toBe(true); // valid EAN-13
    expect(verifyGs1CheckDigit('96385074')).toBe(true); // valid EAN-8
    expect(verifyGs1CheckDigit('036000291452')).toBe(true); // valid UPC-A
    expect(verifyGs1CheckDigit('0036000291452')).toBe(true); // canonical EAN-13 of UPC-A
    expect(verifyGs1CheckDigit('036000291453')).toBe(false);

    // UPC-A canonicalizes to 13-digit EAN-13 form ('0' + upca)
    expect(prepareBarcodeForStorage('036000291452')).toEqual({
      barcode: '0036000291452',
      format: 'upca',
    });
    expect(prepareBarcodeForStorage('036000291452', 'upca')).toEqual({
      barcode: '0036000291452',
      format: 'upca',
    });
    expect(prepareBarcodeForStorage('0036000291452', 'ean13')).toEqual({
      barcode: '0036000291452',
      format: 'ean13',
    });
    expect(prepareBarcodeForStorage('96385074')).toEqual({
      barcode: '96385074',
      format: 'ean8',
    });

    // Bad GS1 check digit rejected unless explicitly marked internal/other (EAN-13, UPC-A, and EAN-8)
    expect(() => prepareBarcodeForStorage('4006381333932', 'ean13')).toThrow(DomainError);
    expect(() => prepareBarcodeForStorage('4006381333932')).toThrow(DomainError);
    expect(() => prepareBarcodeForStorage('036000291453', 'upca')).toThrow(DomainError);
    expect(() => prepareBarcodeForStorage('96385075', 'ean8')).toThrowError(
      /INVALID_BARCODE_CHECK_DIGIT/,
    );
    expect(() => prepareBarcodeForStorage('96385075')).toThrowError(/INVALID_BARCODE_CHECK_DIGIT/);
    expect(prepareBarcodeForStorage('96385075', 'internal')).toEqual({
      barcode: '96385075',
      format: 'internal',
    });
    expect(prepareBarcodeForStorage('4006381333932', 'internal')).toEqual({
      barcode: '4006381333932',
      format: 'internal',
    });
    expect(prepareBarcodeForStorage('INT-0001')).toEqual({
      barcode: 'INT-0001',
      format: 'internal',
    });
    expect(prepareBarcodeForStorage('OTHER-99', 'other')).toEqual({
      barcode: 'OTHER-99',
      format: 'other',
    });

    // Scan candidates convert 12-digit UPC-A to leading '0' first while keeping exact fallback
    expect(buildScanBarcodeCandidates('036000291452')).toEqual(['0036000291452', '036000291452']);
    expect(buildScanBarcodeCandidates('0036000291452')).toEqual(['0036000291452']);

    // Property test: any generated UPC-A matches EAN-13 '0' + UPC-A, and any 1-digit flip fails GS1 check
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 11, maxLength: 11 }),
        fc.integer({ min: 0, max: 11 }),
        fc.integer({ min: 1, max: 9 }),
        (digits, corruptIdx, delta) => {
          const payload = digits.join('');
          const check = computeGs1CheckDigit(payload);
          const upca = `${payload}${String(check)}`;
          const ean13 = `0${upca}`;

          expect(verifyGs1CheckDigit(upca)).toBe(true);
          expect(verifyGs1CheckDigit(ean13)).toBe(true);
          expect(prepareBarcodeForStorage(upca, 'upca').barcode).toBe(ean13);
          expect(prepareBarcodeForStorage(ean13, 'ean13').barcode).toBe(ean13);

          const chars = upca.split('');
          const ch = chars[corruptIdx];
          if (ch === undefined) {
            throw new Error('Missing character at index');
          }
          const orig = ch.charCodeAt(0) - 48;
          chars[corruptIdx] = String((orig + delta) % 10);
          const corrupted = chars.join('');
          expect(verifyGs1CheckDigit(corrupted)).toBe(false);
        },
      ),
    );

    // Property test: any valid 8-digit EAN-8 succeeds, and any 1-digit corruption throws INVALID_BARCODE_CHECK_DIGIT
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 7, maxLength: 7 }),
        fc.integer({ min: 0, max: 7 }),
        fc.integer({ min: 1, max: 9 }),
        (digits, corruptIdx, delta) => {
          const payload = digits.join('');
          const check = computeGs1CheckDigit(payload);
          const ean8 = `${payload}${String(check)}`;

          expect(prepareBarcodeForStorage(ean8, 'ean8')).toEqual({
            barcode: ean8,
            format: 'ean8',
          });
          expect(prepareBarcodeForStorage(ean8)).toEqual({
            barcode: ean8,
            format: 'ean8',
          });

          const chars = ean8.split('');
          const ch = chars[corruptIdx];
          if (ch === undefined) {
            throw new Error('Missing character at index');
          }
          const orig = ch.charCodeAt(0) - 48;
          chars[corruptIdx] = String((orig + delta) % 10);
          const corrupted = chars.join('');

          expect(() => prepareBarcodeForStorage(corrupted, 'ean8')).toThrowError(
            /INVALID_BARCODE_CHECK_DIGIT/,
          );
          expect(() => prepareBarcodeForStorage(corrupted)).toThrowError(
            /INVALID_BARCODE_CHECK_DIGIT/,
          );
        },
      ),
    );
  });

  it('canonicalizes and parses variant attribute objects deterministically', () => {
    const a = canonicalizeVariantAttributes({
      rang: 'Qora',
      '  olcham ': ' XL ',
    });
    const b = canonicalizeVariantAttributes({
      olcham: 'XL',
      rang: 'Qora',
    });

    expect(a.json).toBe('{"olcham":"XL","rang":"Qora"}');
    expect(a.json).toBe(b.json);
    expect(parseVariantAttributesJson(a.json)).toEqual({ olcham: 'XL', rang: 'Qora' });
  });
});
