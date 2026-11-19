import { describe, expect, it } from 'vitest';
import { ProjectionTouchSet, collectTouchedProjectionKeys } from './sync-projection-keys.js';

/**
 * T2.6 deterministic guard for the key collector (D0, D1, D2, D5, D7, D8): each entity that can
 * change a projection must add exactly its key — independent of how lucky a random seed is.
 */
const P = '01990000-0000-7000-8000-0000000000a1';
const C = '01990000-0000-7000-8000-0000000000c1';
const S = '01990000-0000-7000-8000-0000000000d1';
const ROW = '01990000-0000-7000-8000-0000000000e1';

function touched(entity: string, entityId: string, payload: Record<string, unknown>) {
  const t = new ProjectionTouchSet();
  collectTouchedProjectionKeys(t, entity, entityId, payload);
  return {
    products: [...t.productIds],
    customers: [...t.customerIds],
    suppliers: [...t.supplierIds],
  };
}

describe('T2.6 collectTouchedProjectionKeys', () => {
  it.each([
    ['stock_moves', { productId: P }],
    ['batches', { productId: P }],
    ['receiving_cost_confirmations', { productId: P }],
    ['goods_receiving_lines', { productId: P }],
  ])('%s → its product pool', (entity, payload) => {
    expect(touched(entity, ROW, payload)).toEqual({ products: [P], customers: [], suppliers: [] });
  });

  it('products → the product itself (track_batches changes the replay)', () => {
    expect(touched('products', P, {})).toEqual({ products: [P], customers: [], suppliers: [] });
  });

  it('customer ledger / new customer → that customer', () => {
    expect(touched('customer_ledger', ROW, { customerId: C })).toEqual({
      products: [],
      customers: [C],
      suppliers: [],
    });
    expect(touched('customers', C, {})).toEqual({ products: [], customers: [C], suppliers: [] });
  });

  it('supplier ledger / new supplier → that supplier', () => {
    expect(touched('supplier_ledger', ROW, { supplierId: S })).toEqual({
      products: [],
      customers: [],
      suppliers: [S],
    });
    expect(touched('suppliers', S, {})).toEqual({ products: [], customers: [], suppliers: [S] });
  });

  it('entities without a projection, and malformed ids, touch nothing', () => {
    for (const entity of ['sales', 'shifts', 'categories', 'fiscal_docs', 'users']) {
      expect(touched(entity, ROW, { productId: P, customerId: C })).toEqual({
        products: [],
        customers: [],
        suppliers: [],
      });
    }
    expect(touched('stock_moves', ROW, { productId: 'not-a-uuid' }).products).toEqual([]);
    expect(touched('customer_ledger', ROW, {}).customers).toEqual([]);
  });
});
