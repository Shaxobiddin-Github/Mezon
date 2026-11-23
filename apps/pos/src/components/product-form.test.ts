import { setLocale } from '@mezon/i18n';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  NEW_CATEGORY,
  type ProductFormState,
  parseMinStockInput,
  validateProductForm,
} from './CatalogScreen.js';

const base: ProductFormState = {
  name: 'Sut 1 l',
  unit: 'dona',
  salePriceSom: '13 000',
  mxik: '',
  packageCode: '',
  vatPercent: '12',
  barcode: '',
  sku: '',
  categoryId: '',
  newCategoryName: '',
  unlimited: false,
  minStock: '',
};

describe('C11 product form', () => {
  beforeEach(() => {
    setLocale('uz-Latn');
  });

  it('minimal product: no barcode, SKU, category or min stock are sent as null', () => {
    const res = validateProductForm(base);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({
      name: 'Sut 1 l',
      salePrice: '1300000',
      barcode: null,
      sku: null,
      categoryId: null,
      newCategoryName: null,
      unlimited: false,
      minStock: null,
    });
  });

  it('barcode, SKU and min stock are trimmed and normalized (min stock in milli-units)', () => {
    const res = validateProductForm({
      ...base,
      barcode: ' 4780011220012 ',
      sku: ' SUT-1 ',
      minStock: '2,5',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.barcode).toBe('4780011220012');
    expect(res.value.sku).toBe('SUT-1');
    expect(res.value.minStock).toBe('2500');
  });

  it('an unlimited product never sends a min stock, even a typed one', () => {
    const res = validateProductForm({ ...base, unlimited: true, minStock: '5' });
    expect(res.ok && res.value.minStock).toBeNull();
  });

  it('a new category needs a valid name; an existing one must be a real id', () => {
    const bad = validateProductForm({ ...base, categoryId: NEW_CATEGORY, newCategoryName: '  ' });
    expect(bad).toEqual({ ok: false, error: 'Kategoriya nomi notoʻgʻri' });

    const good = validateProductForm({
      ...base,
      categoryId: NEW_CATEGORY,
      newCategoryName: 'Sut mahsulotlari',
    });
    expect(good.ok && good.value.newCategoryName).toBe('Sut mahsulotlari');
    expect(good.ok && good.value.categoryId).toBeNull();

    const notAnId = validateProductForm({ ...base, categoryId: 'abc' });
    expect(notAnId.ok).toBe(false);
  });

  it('browser 11-21: a wrong EAN-13 check digit is caught in the form, before any request', () => {
    expect(validateProductForm({ ...base, barcode: '4780011220017' })).toEqual({
      ok: false,
      error: 'Shtrix-kodning oxirgi (nazorat) raqami notoʻgʻri. Kodni qayta skanerlang.',
    });
    // An internal code (not 8/12/13 digits) has no GS1 check digit.
    expect(validateProductForm({ ...base, barcode: 'QTQ-05' }).ok).toBe(true);
  });

  it('rejects a bad barcode, a bad min stock and a negative min stock', () => {
    expect(validateProductForm({ ...base, barcode: 'x'.repeat(129) })).toEqual({
      ok: false,
      error: 'Shtrix-kod notoʻgʻri',
    });
    expect(validateProductForm({ ...base, minStock: 'besh' }).ok).toBe(false);
    expect(parseMinStockInput('-1')).toBeUndefined();
    expect(parseMinStockInput('0.125')).toBe('125');
    expect(parseMinStockInput('')).toBeNull();
  });
});
