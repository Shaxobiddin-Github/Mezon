import { describe, expect, it } from 'vitest';
import {
  BusinessDateSchema,
  CloseBusinessDayRequestSchema,
  CloseShiftRequestSchema,
  CreateShiftCashMoveRequestSchema,
  HandoffCashierRequestSchema,
  OpenShiftRequestSchema,
  RecloseShiftRequestSchema,
} from './shift.js';

const UID = (n: number) => `01950000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('@mezon/contracts - T1.9 shift & day-close strict schemas', () => {
  it('validates OpenShiftRequestSchema and denomination counts', () => {
    const ok = OpenShiftRequestSchema.parse({
      clientRequestId: UID(1),
      openingCash: '500000',
      denominations: [{ nominal: '100000', count: 5 }],
      note: '  Tongi smena  ',
    });
    expect(ok.note).toBe('Tongi smena');

    expect(() =>
      OpenShiftRequestSchema.parse({
        clientRequestId: UID(1),
        openingCash: '500000',
        extraManualCardTotal: '10000',
      }),
    ).toThrow();
  });

  it('STRICTLY rejects manual non-cash inputs in close, reclose, and handoff schemas (400)', () => {
    const forbiddenNonCashFields = [
      { cardTotal: '50000' },
      { card: '50000' },
      { uzqr: '10000' },
      { payme: '10000' },
      { click: '10000' },
      { uzum: '10000' },
      { nonCashTotals: [{ method: 'card', amount: '50000' }] },
      { methodTotals: [] },
      { expectedCash: '500000' },
      { salesTotal: '900000' },
    ];

    for (const badField of forbiddenNonCashFields) {
      expect(() =>
        CloseShiftRequestSchema.parse({
          clientRequestId: UID(2),
          countedCash: '500000',
          ...badField,
        }),
      ).toThrow();

      expect(() =>
        RecloseShiftRequestSchema.parse({
          clientRequestId: UID(3),
          countedCash: '500000',
          reason: 'Qayta sanoq',
          ...badField,
        }),
      ).toThrow();

      expect(() =>
        HandoffCashierRequestSchema.parse({
          clientRequestId: UID(4),
          nextCashierUserId: UID(5),
          countedCash: '500000',
          ...badField,
        }),
      ).toThrow();
    }
  });

  it('validates CreateShiftCashMoveRequestSchema and restricts expenseCategory to cash_out', () => {
    const okOut = CreateShiftCashMoveRequestSchema.parse({
      clientRequestId: UID(1),
      type: 'cash_out',
      amount: '250000',
      reason: '  Kuryer  ',
      expenseCategory: 'transport',
    });
    expect(okOut.reason).toBe('Kuryer');
    expect(okOut.expenseCategory).toBe('transport');

    expect(() =>
      CreateShiftCashMoveRequestSchema.parse({
        clientRequestId: UID(1),
        type: 'encashment',
        amount: '250000',
        reason: 'Inkassatsiya',
        expenseCategory: 'other',
      }),
    ).toThrow();
  });

  it('validates calendar dates in BusinessDateSchema and CloseBusinessDayRequestSchema', () => {
    expect(BusinessDateSchema.parse(' 2024-02-29 ')).toBe('2024-02-29');
    expect(() => BusinessDateSchema.parse('2025-02-29')).toThrow();
    expect(() => BusinessDateSchema.parse('2026-13-01')).toThrow();

    const dayReq = CloseBusinessDayRequestSchema.parse({
      clientRequestId: UID(6),
      businessDate: '2026-11-11',
      note: '   ',
    });
    expect(dayReq.note).toBeNull();
  });
});
