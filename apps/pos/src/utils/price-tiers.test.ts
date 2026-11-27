import { describe, expect, it } from 'vitest';
import { parseMinStockInput } from '../components/CatalogScreen.js';
import { parseTierDrafts, tierHint } from './price-tiers.js';
import { parseUuidV7 } from '@mezon/domain';
import { parseSomInputToTiyinString } from '@mezon/ui';

const SHELF = 2_000_000n; // 20 000 so'm
const parse = (rows: { qty: string; priceSom: string }[]) =>
  parseTierDrafts(rows, SHELF, parseMinStockInput, parseSomInputToTiyinString);

describe('C20 wholesale tier form', () => {
  it('turns rows into sorted milli/tiyin tiers and skips empty rows', () => {
    const r = parse([
      { qty: '10', priceSom: '18000' },
      { qty: '', priceSom: '' },
      { qty: '5', priceSom: '19 000' },
    ]);
    expect(r).toEqual({
      ok: true,
      tiers: [
        { minQty: '5000', unitPrice: '1900000' },
        { minQty: '10000', unitPrice: '1800000' },
      ],
    });
  });

  it('accepts a fractional kg quantity', () => {
    expect(parse([{ qty: '2,5', priceSom: '9000' }])).toEqual({
      ok: true,
      tiers: [{ minQty: '2500', unitPrice: '900000' }],
    });
  });

  it('refuses quantity 1 or less, a price not below the shelf, equal quantities, dearer bulk', () => {
    expect(parse([{ qty: '1', priceSom: '19000' }])).toEqual({
      ok: false,
      error: 'pos.wholesale.errQty',
    });
    expect(parse([{ qty: '5', priceSom: '20000' }])).toEqual({
      ok: false,
      error: 'pos.wholesale.errPrice',
    });
    expect(parse([{ qty: '5', priceSom: 'abc' }])).toEqual({
      ok: false,
      error: 'pos.wholesale.errPrice',
    });
    expect(
      parse([
        { qty: '5', priceSom: '19000' },
        { qty: '5,0', priceSom: '18000' },
      ]),
    ).toEqual({ ok: false, error: 'pos.wholesale.errSameQty' });
    expect(
      parse([
        { qty: '5', priceSom: '18000' },
        { qty: '10', priceSom: '19000' },
      ]),
    ).toEqual({ ok: false, error: 'pos.wholesale.errOrder' });
  });

  it('the sale-screen hint shows the smallest tier', () => {
    const id = parseUuidV7('01950000-0000-7000-8000-000000000001');
    expect(tierHint(undefined)).toBeNull();
    expect(
      tierHint([
        { id, productId: id, minQty: '10000', unitPrice: '1800000' },
        { id, productId: id, minQty: '5000', unitPrice: '1900000' },
      ]),
    ).toEqual({ qty: '5', price: '1900000' });
  });
});
