import { MAX_MONEY_TIYIN } from '@mezon/domain';
import { describe, expect, it } from 'vitest';
import {
  CompleteSaleRequestSchema,
  CreateCustomerRequestSchema,
  CreateDebtAdjustmentRequestSchema,
  CreateDebtPaymentRequestSchema,
  CreateOpeningBalanceRequestSchema,
  CustomerDetailResponseSchema,
  CustomerSummaryDtoSchema,
} from './index.js';

const UUID_1 = '01970000-0000-7000-8000-000000000001';
const UUID_2 = '01970000-0000-7000-8000-000000000002';

describe('@mezon/contracts - customer, ledger, and credit sale schemas', () => {
  it('validates CreateCustomerRequestSchema with E.164 normalization and never leaks phone into Zod errors', () => {
    const ok = CreateCustomerRequestSchema.parse({
      fullName: '  Javohir   Toshmatov ',
      phone: '90 555-12-34',
      creditLimit: '500000',
      defaultDueDays: 14,
      note: ' Doimiy mijoz ',
    });
    expect(ok.fullName).toBe('Javohir Toshmatov');
    expect(ok.phone).toBe('+998905551234');
    expect(ok.note).toBe('Doimiy mijoz');

    const kz = CreateCustomerRequestSchema.parse({
      fullName: 'Timur',
      phone: '+7 701 555 44 33',
    });
    expect(kz.phone).toBe('+77015554433');

    const badPhone = '99990001122';
    const parsedBad = CreateCustomerRequestSchema.safeParse({
      fullName: 'Secret Name',
      phone: badPhone,
    });
    expect(parsedBad.success).toBe(false);
    if (!parsedBad.success) {
      const msg = parsedBad.error.issues.map((i) => i.message).join('; ');
      expect(msg).not.toContain(badPhone);
    }
  });

  it('validates debt payments, opening balances, adjustments, and CompleteSaleRequestSchema creditOverride/dueDays', () => {
    const payCash = CreateDebtPaymentRequestSchema.parse({
      clientRequestId: UUID_1,
      method: 'cash',
      amount: '50000',
    });
    expect(payCash.amount).toBe('50000');

    expect(
      CreateDebtPaymentRequestSchema.safeParse({
        clientRequestId: UUID_1,
        method: 'cash',
        amount: '50000',
        providerRef: 'INVALID-CASH-REF',
      }).success,
    ).toBe(false);

    expect(
      CreateDebtAdjustmentRequestSchema.safeParse({
        clientRequestId: UUID_1,
        amountDelta: '0',
        reason: 'Nol bolmasligi kerak',
      }).success,
    ).toBe(false);

    expect(
      CreateOpeningBalanceRequestSchema.safeParse({
        clientRequestId: UUID_1,
        amount: (MAX_MONEY_TIYIN + 1n).toString(),
        reason: 'Overflow',
      }).success,
    ).toBe(false);

    const creditSale = CompleteSaleRequestSchema.parse({
      clientRequestId: UUID_1,
      expectedTotal: '100000',
      debtAmount: '60000',
      customerId: UUID_2,
      dueDays: 7,
      creditOverride: { username: 'mgr', pin: '592817' },
      payments: [{ method: 'cash', tenderedAmount: '40000' }],
    });
    expect(creditSale.dueDays).toBe(7);
    expect(creditSale.customerId).toBe(UUID_2);
  });

  it('strictly excludes costValue and profit fields from CustomerSummaryDtoSchema & CustomerDetailResponseSchema', () => {
    const summaryKeys = Object.keys(CustomerSummaryDtoSchema.shape);
    expect(summaryKeys).not.toContain('costValue');
    expect(summaryKeys).not.toContain('profit');

    const badDetail = CustomerDetailResponseSchema.safeParse({
      customer: {
        id: UUID_1,
        organizationId: UUID_2,
        fullName: 'Alisher',
        phoneNormalized: null,
        creditLimit: null,
        defaultDueDays: null,
        note: null,
        isActive: true,
        balance: '0',
        totalDebtAccrued: '0',
        totalSettled: '0',
        overdueAmount: '0',
        oldestOverdueDays: 0,
        lastActivityAtMs: null,
        createdAtMs: '1000',
        updatedAtMs: '1000',
        costValue: '999',
      },
      openObligations: [],
    });
    expect(badDetail.success).toBe(false);
  });
});
