import { describe, expect, it } from 'vitest';
import {
  CashierStockBalanceSchema,
  CreateInboundStockMoveRequestSchema,
  CreateOutboundStockMoveRequestSchema,
  RecordInventoryCountLinesRequestSchema,
  StockValuationItemSchema,
} from './index.js';

describe('@mezon/contracts - stock ledger, batches, inventory counts, and cashier balance DTOs', () => {
  it('enforces strict no-cost shape on CashierStockBalanceSchema and parses manager valuation separately', () => {
    const prodId = '01950000-0000-7000-8000-000000000001';
    const cashierSafe = CashierStockBalanceSchema.parse({
      productId: prodId,
      variantId: null,
      productName: 'Olma',
      unit: 'kg',
      unlimited: false,
      trackBatches: true,
      minStock: '5000',
      qtyOnHand: '-2500',
      isLowStock: true,
    });
    expect(cashierSafe.qtyOnHand).toBe('-2500');

    expect(() =>
      CashierStockBalanceSchema.parse({
        productId: prodId,
        variantId: null,
        productName: 'Olma',
        unit: 'kg',
        unlimited: false,
        trackBatches: true,
        minStock: null,
        qtyOnHand: '1000',
        isLowStock: false,
        totalValue: '500000',
      }),
    ).toThrow();

    const ownerVal = StockValuationItemSchema.parse({
      productId: prodId,
      variantId: null,
      productName: 'Olma',
      unit: 'kg',
      trackBatches: true,
      qtyOnHand: '10000',
      totalValue: '1500000',
      deficitQty: '0',
      provisionalDeficitValue: '0',
      costVarianceValue: '-250',
      lastUnitCost: '150000',
      updatedAtMs: '1760000000000',
    });
    expect(ownerVal.costVarianceValue).toBe('-250');
  });

  it('validates inbound/outbound move requests and partial inventory count payloads', () => {
    const prodId = '01950000-0000-7000-8000-000000000001';
    const inbound = CreateInboundStockMoveRequestSchema.parse({
      productId: prodId,
      reason: 'purchase',
      qty: '5500',
      totalCostValue: '8250000',
      batchNumber: '  LOT-2026-A ',
      expiryDateMs: '1790000000000',
    });
    expect(inbound.batchNumber).toBe('LOT-2026-A');

    expect(() =>
      CreateInboundStockMoveRequestSchema.parse({
        productId: prodId,
        reason: 'damaged',
        qty: '1000',
        totalCostValue: '1000',
      }),
    ).toThrow();

    const outbound = CreateOutboundStockMoveRequestSchema.parse({
      productId: prodId,
      reason: 'damaged',
      qty: '2000',
      policy: 'block',
    });
    expect(outbound.policy).toBe('block');

    const lines = RecordInventoryCountLinesRequestSchema.parse({
      lines: [
        { productId: prodId, countedQty: '8000' },
        { productId: prodId, variantId: prodId, countedQty: null },
      ],
    });
    expect(lines.lines).toHaveLength(2);
  });
});
