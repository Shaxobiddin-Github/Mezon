import { describe, expect, it } from 'vitest';
import { ListProductsQuerySchema } from './catalog.js';
import {
  TaxProfileResponseSchema,
  TinSchema,
  UpdateTaxProfileRequestSchema,
} from './tax-settings.js';

describe('@mezon/contracts - T3.1 tax settings', () => {
  it('TinSchema accepts exactly 9 digits (trimmed) and rejects everything else', () => {
    expect(TinSchema.parse('123456789')).toBe('123456789');
    expect(TinSchema.parse('  123456789 ')).toBe('123456789');
    for (const bad of [
      '12345678', // 8
      '1234567890', // 10
      '12345678a',
      '1234 5678',
      '',
      '١٢٣٤٥٦٧٨٩', // non-ASCII digits
      '-12345678',
    ]) {
      expect(TinSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('UpdateTaxProfileRequestSchema normalizes text, requires all fields and bounds VAT', () => {
    const ok = UpdateTaxProfileRequestSchema.parse({
      tin: '305123456',
      legalName: '  "Guzar Savdo" MChJ ',
      legalAddress: ' Kattaqoʻrgʻon sh., Mustaqillik 1 ',
      isVatPayer: true,
      defaultVatRateBp: 1200,
    });
    expect(ok.legalName).toBe('"Guzar Savdo" MChJ');
    expect(ok.legalAddress).toBe('Kattaqoʻrgʻon sh., Mustaqillik 1');

    const base = {
      tin: '305123456',
      legalName: 'A',
      legalAddress: 'B',
      isVatPayer: false,
      defaultVatRateBp: 0,
    };
    expect(UpdateTaxProfileRequestSchema.safeParse({ ...base, legalName: '   ' }).success).toBe(
      false,
    );
    expect(UpdateTaxProfileRequestSchema.safeParse({ ...base, legalAddress: '' }).success).toBe(
      false,
    );
    expect(
      UpdateTaxProfileRequestSchema.safeParse({ ...base, defaultVatRateBp: 10_001 }).success,
    ).toBe(false);
    expect(UpdateTaxProfileRequestSchema.safeParse({ ...base, defaultVatRateBp: -1 }).success).toBe(
      false,
    );
    expect(UpdateTaxProfileRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    const { isVatPayer: _omit, ...missing } = base;
    expect(UpdateTaxProfileRequestSchema.safeParse(missing).success).toBe(false);
  });

  it('TaxProfileResponseSchema allows a not-yet-configured (null) profile', () => {
    expect(TaxProfileResponseSchema.parse({ profile: null }).profile).toBeNull();
  });

  it('ListProductsQuerySchema parses missingMxik from the query string', () => {
    expect(ListProductsQuerySchema.parse({ missingMxik: 'true' }).missingMxik).toBe(true);
    expect(ListProductsQuerySchema.parse({ missingMxik: 'false' }).missingMxik).toBe(false);
    expect(ListProductsQuerySchema.parse({}).missingMxik).toBeUndefined();
    expect(ListProductsQuerySchema.safeParse({ missingMxik: 'yes' }).success).toBe(false);
  });
});
