import { describe, expect, it } from 'vitest';
import {
  ConfirmReceivingLineCostRequestSchema,
  CreateReceivingDraftRequestSchema,
  CreateSupplierAdjustmentRequestSchema,
  CreateSupplierPaymentRequestSchema,
  CreateSupplierRequestSchema,
  CreateSupplierReturnRequestSchema,
  SupplierLedgerEntryDtoSchema,
  SupplierSummaryDtoSchema,
} from './index.js';

const UUID_1 = '01950000-0000-7000-8000-000000000001';
const UUID_2 = '01950000-0000-7000-8000-000000000002';
const UUID_3 = '01950000-0000-7000-8000-000000000003';

describe('@mezon/contracts - supplier, receiving, cost confirmation & return DTOs', () => {
  it('validates STIR and phone without leaking raw values into Zod errors', () => {
    const ok = CreateSupplierRequestSchema.parse({
      name: 'Baraka Ulgurji MCHJ',
      tin: '305 112 987',
      phone: '90 123-45-67',
      defaultDueDays: 21,
    });
    expect(ok.tin).toBe('305112987');
    expect(ok.phone).toBe('+998901234567');

    const badTin = CreateSupplierRequestSchema.safeParse({
      name: 'Bad TIN',
      tin: '12345678',
    });
    expect(badTin.success).toBe(false);
    if (!badTin.success) {
      expect(JSON.stringify(badTin.error.issues)).not.toContain('12345678');
    }

    const badPhone = CreateSupplierRequestSchema.safeParse({
      name: 'Bad Phone',
      phone: '+000555444333',
    });
    expect(badPhone.success).toBe(false);
    if (!badPhone.success) {
      expect(JSON.stringify(badPhone.error.issues)).not.toContain('000555444333');
    }
  });

  it('enforces unknown-cost consistency on receiving draft lines and non-social payment methods', () => {
    const validDraft = CreateReceivingDraftRequestSchema.parse({
      supplierId: UUID_1,
      lines: [
        {
          productId: UUID_2,
          qty: '5500',
          costUnknown: true,
          totalCostValue: null,
        },
        {
          productId: UUID_3,
          qty: '2000',
          costUnknown: false,
          totalCostValue: '40000',
          batchNumber: 'LOT-44',
        },
      ],
    });
    expect(validDraft.lines).toHaveLength(2);

    // costUnknown: true with non-null cost rejected
    expect(
      CreateReceivingDraftRequestSchema.safeParse({
        supplierId: UUID_1,
        lines: [{ productId: UUID_2, qty: '1000', costUnknown: true, totalCostValue: '1000' }],
      }).success,
    ).toBe(false);

    // costUnknown: false with null cost rejected
    expect(
      CreateReceivingDraftRequestSchema.safeParse({
        supplierId: UUID_1,
        lines: [{ productId: UUID_2, qty: '1000', costUnknown: false, totalCostValue: null }],
      }).success,
    ).toBe(false);

    // Supplier payment rejects social_card and cash+providerRef
    expect(
      CreateSupplierPaymentRequestSchema.safeParse({
        clientRequestId: UUID_1,
        method: 'social_card',
        amount: '10000',
      }).success,
    ).toBe(false);
    expect(
      CreateSupplierPaymentRequestSchema.safeParse({
        clientRequestId: UUID_1,
        method: 'cash',
        amount: '10000',
        providerRef: 'RRN-1',
      }).success,
    ).toBe(false);

    expect(
      ConfirmReceivingLineCostRequestSchema.safeParse({
        clientRequestId: UUID_1,
        confirmedTotalCost: '75000',
        reason: 'Factura keldi',
      }).success,
    ).toBe(true);

    expect(
      CreateSupplierReturnRequestSchema.safeParse({
        clientRequestId: UUID_1,
        reason: 'Nuqsonli mahsulot',
        items: [{ receivingLineId: UUID_2, qty: '1000' }],
      }).success,
    ).toBe(true);

    expect(
      CreateSupplierAdjustmentRequestSchema.safeParse({
        clientRequestId: UUID_1,
        amountDelta: '0',
        reason: 'Zero invalid',
      }).success,
    ).toBe(false);
  });

  it('allows negative supplier advance balance in summary and ledger DTOs', () => {
    const summary = SupplierSummaryDtoSchema.parse({
      id: UUID_1,
      organizationId: UUID_2,
      name: 'Avans Supplier',
      tin: null,
      phoneNormalized: null,
      contactPerson: null,
      defaultDueDays: 14,
      note: null,
      isActive: true,
      balance: '-50000',
      debtBalance: '0',
      advanceBalance: '50000',
      totalDebtAccrued: '100000',
      totalCredited: '150000',
      overdueAmount: '0',
      oldestOverdueDays: 0,
      lastActivityAtMs: '1780000000000',
      createdAtMs: '1780000000000',
      updatedAtMs: '1780000000000',
    });
    expect(summary.balance).toBe('-50000');

    const entry = SupplierLedgerEntryDtoSchema.parse({
      id: UUID_1,
      organizationId: UUID_2,
      storeId: UUID_3,
      deviceId: UUID_1,
      supplierId: UUID_2,
      entryType: 'supplier_payment',
      amountDelta: '-50000',
      balanceAfter: '-50000',
      sourceType: 'supplier_payment',
      sourceId: UUID_3,
      receivingId: null,
      supplierReturnId: null,
      paymentMethod: 'cash',
      providerRef: null,
      cashMoveId: UUID_1,
      dueAtMs: null,
      reason: 'Avans',
      createdByUserId: UUID_1,
      createdAtMs: '1780000000000',
    });
    expect(entry.balanceAfter).toBe('-50000');
  });
});
