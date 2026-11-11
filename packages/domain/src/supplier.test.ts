import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DomainError,
  type SupplierLedgerEntryForFifo,
  type UuidV7,
  ZERO_MONEY,
  allocateSupplierLedgerFifo,
  applyReplayStockMove,
  applyStockCostConfirmation,
  canonicalizeConfirmReceivingCostRequest,
  canonicalizePostReceivingRequest,
  canonicalizeSupplierPaymentRequest,
  canonicalizeSupplierReturnRequest,
  computeNextSupplierBalance,
  computeSupplierDueAtMs,
  createEmptyStockPoolState,
  formatReceivingCode,
  formatSupplierReturnCode,
  moneyFromTiyin,
  moneyToTiyin,
  normalizeSupplierName,
  normalizeSupplierPhone,
  normalizeSupplierTin,
  parseSupplierPaymentMethod,
  quantityFromMilli,
  quantityToMilli,
  unixMsFromBigInt,
  validateReceivingLineCostInput,
} from './index.js';

const ORG_DEV_ID = '01950000-0000-7000-8000-000000000011' as UuidV7;
const PROD_ID = '01950000-0000-7000-8000-000000000101' as UuidV7;
const BATCH_A = '01950000-0000-7000-8000-000000000201' as UuidV7;
const BATCH_B = '01950000-0000-7000-8000-000000000202' as UuidV7;
const RCV_1 = '01950000-0000-7000-8000-000000000301' as UuidV7;
const SUP_1 = '01950000-0000-7000-8000-000000000401' as UuidV7;

function makeId(index: number): UuidV7 {
  return `01950000-0000-7000-8000-${index.toString(16).padStart(12, '0')}` as UuidV7;
}

function makeHlc(seq: number): string {
  return `${BigInt(1_780_000_000_000 + seq)
    .toString()
    .padStart(15, '0')}:00000:${ORG_DEV_ID}`;
}

describe('@mezon/domain - supplier ledger, advance FIFO, E1 unknown-cost & E2 return bounds', () => {
  it('validates STIR (9 digits), E.164/UZ phones, codes & PII-free errors', () => {
    expect(normalizeSupplierName('  Agro   Export LLC ')).toBe('Agro Export LLC');
    expect(() => normalizeSupplierName('   ')).toThrowError(DomainError);

    expect(normalizeSupplierTin(null)).toBeNull();
    expect(normalizeSupplierTin(' 305 412-987 ')).toBe('305412987');
    let tinErrMsg = '';
    try {
      normalizeSupplierTin('99887766');
    } catch (e) {
      tinErrMsg = (e as Error).message;
    }
    expect(tinErrMsg).toContain('9 digits');
    expect(tinErrMsg).not.toContain('99887766');

    expect(normalizeSupplierPhone('90 555-66-77')?.phoneNormalized).toBe('+998905556677');
    expect(normalizeSupplierPhone('+992 92 777 88 99')?.phoneNormalized).toBe('+992927778899');

    expect(formatReceivingCode(ORG_DEV_ID, 7n)).toBe('RCV-0011-000007');
    expect(formatSupplierReturnCode(ORG_DEV_ID, 12n)).toBe('SRT-0011-000012');

    expect(() => parseSupplierPaymentMethod('social_card')).toThrowError(DomainError);
    expect(parseSupplierPaymentMethod('payme')).toBe('payme');

    expect(
      moneyToTiyin(validateReceivingLineCostInput({ costUnknown: true, totalCostValue: null })),
    ).toBe(0n);
    expect(() =>
      validateReceivingLineCostInput({
        costUnknown: true,
        totalCostValue: moneyFromTiyin(100n),
      }),
    ).toThrowError(DomainError);
    expect(() =>
      validateReceivingLineCostInput({ costUnknown: false, totalCostValue: null }),
    ).toThrowError(DomainError);
  });

  it('allows negative supplier balance (advance) and closes future debt FIFO in strict HLC order', () => {
    const t0 = unixMsFromBigInt(1_781_500_000_000n); // 2026-06-15 Tashkent noon
    const dueEarly = computeSupplierDueAtMs({
      createdAtMs: t0,
      dueDays: 2,
      storeTimezone: 'Asia/Tashkent',
    })!;
    const dueLate = computeSupplierDueAtMs({
      createdAtMs: unixMsFromBigInt(1_781_500_000_000n + 86_400_000n),
      dueDays: 5,
      storeTimezone: 'Asia/Tashkent',
    })!;

    // Prepay 100_000 BEFORE any receiving arrives, then receive 60_000 (covered by advance -> 0 open debt, -40_000 balance)
    // then receive 90_000 (+50_000 open debt after remaining 40_000 advance) -> past dueEarly!
    const entries: SupplierLedgerEntryForFifo[] = [
      {
        id: makeId(3),
        hlc: makeHlc(30),
        createdAtMs: unixMsFromBigInt(1_781_500_000_000n + 86_400_000n),
        entryType: 'receiving_debt',
        amountDelta: moneyFromTiyin(90_000n),
        sourceType: 'receiving',
        receivingId: makeId(902),
        paymentMethod: null,
        dueAtMs: dueLate,
      },
      {
        id: makeId(1),
        hlc: makeHlc(10),
        createdAtMs: t0,
        entryType: 'supplier_payment',
        amountDelta: moneyFromTiyin(-100_000n),
        sourceType: 'supplier_payment',
        receivingId: null,
        paymentMethod: 'cash',
        dueAtMs: null,
      },
      {
        id: makeId(2),
        hlc: makeHlc(20),
        createdAtMs: t0,
        entryType: 'receiving_debt',
        amountDelta: moneyFromTiyin(60_000n),
        sourceType: 'receiving',
        receivingId: RCV_1,
        paymentMethod: null,
        dueAtMs: dueEarly,
      },
    ];

    const resBeforeLateDue = allocateSupplierLedgerFifo({
      entries,
      asOfMs: unixMsFromBigInt(BigInt(dueEarly) + 1_000n),
      storeTimezone: 'Asia/Tashkent',
    });
    expect(resBeforeLateDue.balanceTiyin).toBe(50_000n);
    expect(moneyToTiyin(resBeforeLateDue.debtBalance)).toBe(50_000n);
    expect(resBeforeLateDue.advanceBalance).toBe(ZERO_MONEY);
    // RCV_1 (dueEarly) was 100% covered by prepayment advance -> NOT overdue!
    expect(resBeforeLateDue.overdueAmount).toBe(ZERO_MONEY);

    const resAfterLateDue = allocateSupplierLedgerFifo({
      entries,
      asOfMs: unixMsFromBigInt(BigInt(dueLate) + 1_000n),
      storeTimezone: 'Asia/Tashkent',
    });
    expect(moneyToTiyin(resAfterLateDue.overdueAmount)).toBe(50_000n);
    expect(resAfterLateDue.oldestOverdueDays).toBe(1n);

    // Next balance probe allowing negative
    expect(
      computeNextSupplierBalance({
        currentBalanceTiyin: 10_000n,
        deltaTiyin: -35_000n,
        operation: 'supplier_payment',
      }),
    ).toBe(-25_000n);
  });

  it('E1 Oracle A: unknown cost + immediate confirm === direct purchase (FIFO and Weighted Average)', () => {
    for (const trackBatches of [true, false]) {
      const twinDirect = createEmptyStockPoolState();
      const twinConfirm = createEmptyStockPoolState();

      // Seed prior identical state (including initial deficit for maximum coverage!)
      const priorMoves = [
        {
          moveId: makeId(100),
          productId: PROD_ID,
          variantId: null,
          batchId: trackBatches ? BATCH_A : null,
          hlc: makeHlc(1),
          reason: 'initial' as const,
          qtyDelta: quantityFromMilli(3_000n),
          costValueDelta: moneyFromTiyin(30_000n),
          trackBatches,
        },
        {
          moveId: makeId(101),
          productId: PROD_ID,
          variantId: null,
          batchId: trackBatches ? BATCH_A : null,
          hlc: makeHlc(2),
          reason: 'sale' as const,
          qtyDelta: quantityFromMilli(-5_000n),
          costValueDelta: moneyFromTiyin(-50_000n),
          trackBatches,
        },
      ];
      for (const m of priorMoves) {
        applyReplayStockMove(twinDirect, m);
        applyReplayStockMove(twinConfirm, {
          ...m,
          batchId: trackBatches ? BATCH_A : null,
        });
      }

      // Twin 1: direct purchase of 5.500 kg for 77_000 tiyin
      applyReplayStockMove(twinDirect, {
        moveId: makeId(102),
        productId: PROD_ID,
        variantId: null,
        batchId: trackBatches ? BATCH_B : null,
        hlc: makeHlc(3),
        reason: 'purchase',
        qtyDelta: quantityFromMilli(5_500n),
        costValueDelta: moneyFromTiyin(77_000n),
        trackBatches,
      });

      // Twin 2: unknown cost purchase of 5.500 kg (cost=0) + immediate confirmation X = 77_000
      const unknownConflicts = applyReplayStockMove(twinConfirm, {
        moveId: makeId(103),
        productId: PROD_ID,
        variantId: null,
        batchId: trackBatches ? BATCH_B : null,
        hlc: makeHlc(3),
        reason: 'purchase',
        qtyDelta: quantityFromMilli(5_500n),
        costValueDelta: ZERO_MONEY,
        trackBatches,
        isUnknownCost: true,
      });
      expect(unknownConflicts.map((c) => c.reason)).toEqual(['UNKNOWN_COST_SURPLUS']);
      // Unknown cost must NOT clobber existing lastUnitCost (still 10_000n)
      expect(moneyToTiyin(twinConfirm.lastUnitCost!)).toBe(10_000n);

      applyStockCostConfirmation(twinConfirm, {
        confirmationId: makeId(104),
        productId: PROD_ID,
        variantId: null,
        batchId: trackBatches ? BATCH_B : null,
        hlc: makeHlc(4),
        receivedQty: quantityFromMilli(5_500n),
        confirmedTotalCost: moneyFromTiyin(77_000n),
        trackBatches,
      });

      expect(twinConfirm.qtyOnHand).toBe(twinDirect.qtyOnHand);
      expect(twinConfirm.totalValue).toBe(twinDirect.totalValue);
      expect(twinConfirm.deficitQty).toBe(twinDirect.deficitQty);
      expect(twinConfirm.provisionalDeficitValue).toBe(twinDirect.provisionalDeficitValue);
      expect(twinConfirm.costVarianceValue).toBe(twinDirect.costVarianceValue);
      expect(twinConfirm.lastUnitCost).toBe(twinDirect.lastUnitCost);
      expect([...twinConfirm.batches.entries()]).toEqual([...twinDirect.batches.entries()]);
    }
  });

  it('E1 Oracle B + E2: mixed unknown cost/confirm/sales keep conservation exact & supplier return never pushes pool totalValue negative', () => {
    // E2 exact boundary from spec: pool = 10 units @ 100; supplier_return = 5 units @ original 150
    const pool = createEmptyStockPoolState();
    applyReplayStockMove(pool, {
      moveId: makeId(201),
      productId: PROD_ID,
      variantId: null,
      batchId: null,
      hlc: makeHlc(1),
      reason: 'purchase',
      qtyDelta: quantityFromMilli(10_000n),
      costValueDelta: moneyFromTiyin(100n),
      trackBatches: false,
    });
    applyReplayStockMove(pool, {
      moveId: makeId(202),
      productId: PROD_ID,
      variantId: null,
      batchId: null,
      hlc: makeHlc(2),
      reason: 'supplier_return',
      qtyDelta: quantityFromMilli(-5_000n),
      costValueDelta: moneyFromTiyin(-150n),
      trackBatches: false,
    });

    expect(quantityToMilli(pool.qtyOnHand)).toBe(5_000n);
    expect(moneyToTiyin(pool.totalValue)).toBe(0n); // NEVER -50n!
    expect(moneyToTiyin(pool.costVarianceValue)).toBe(-50n); // 100 - 150 = -50n
    // Conservation: in(100) === out(150) + totalValue(0) - prov(0) + variance(-50)
    expect(150n + moneyToTiyin(pool.totalValue) + moneyToTiyin(pool.costVarianceValue)).toBe(100n);

    // E1 Oracle B: partial sales on unknown cost before confirmation
    const avgPool = createEmptyStockPoolState();
    let inTotal = 0n;
    const outTotal = 0n;
    // Receive 10 units unknown cost -> sell 6 -> confirm 80_000 (Q_rem = min(4, 10) = 4 -> 32_000 on hand, 48_000 variance)
    applyReplayStockMove(avgPool, {
      moveId: makeId(301),
      productId: PROD_ID,
      variantId: null,
      batchId: null,
      hlc: makeHlc(10),
      reason: 'purchase',
      qtyDelta: quantityFromMilli(10_000n),
      costValueDelta: ZERO_MONEY,
      trackBatches: false,
      isUnknownCost: true,
    });
    applyReplayStockMove(avgPool, {
      moveId: makeId(302),
      productId: PROD_ID,
      variantId: null,
      batchId: null,
      hlc: makeHlc(11),
      reason: 'sale',
      qtyDelta: quantityFromMilli(-6_000n),
      costValueDelta: ZERO_MONEY,
      trackBatches: false,
    });
    applyStockCostConfirmation(avgPool, {
      confirmationId: makeId(303),
      productId: PROD_ID,
      variantId: null,
      batchId: null,
      hlc: makeHlc(12),
      receivedQty: quantityFromMilli(10_000n),
      confirmedTotalCost: moneyFromTiyin(80_000n),
      trackBatches: false,
    });
    inTotal += 80_000n;
    expect(quantityToMilli(avgPool.qtyOnHand)).toBe(4_000n);
    expect(moneyToTiyin(avgPool.totalValue)).toBe(32_000n);
    expect(moneyToTiyin(avgPool.costVarianceValue)).toBe(48_000n);
    expect(
      outTotal +
        moneyToTiyin(avgPool.totalValue) -
        moneyToTiyin(avgPool.provisionalDeficitValue) +
        moneyToTiyin(avgPool.costVarianceValue),
    ).toBe(inTotal);
  });

  it('property test (300 runs): bi-directional supplier FIFO + advance preserves balance identity and HLC order invariance', () => {
    const asOfMs = unixMsFromBigInt(1_782_000_000_000n);
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom<
              | 'opening_balance'
              | 'receiving_debt'
              | 'supplier_payment'
              | 'supplier_return'
              | 'adjustment_pos'
              | 'adjustment_neg'
            >(
              'opening_balance',
              'receiving_debt',
              'supplier_payment',
              'supplier_return',
              'adjustment_pos',
              'adjustment_neg',
            ),
            amt: fc.bigInt({ min: 1n, max: 500_000n }),
            overdue: fc.boolean(),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (ops) => {
          let sawOpening = false;
          const entries: SupplierLedgerEntryForFifo[] = [];
          let exactSum = 0n;

          for (let i = 0; i < ops.length; i += 1) {
            const op = ops[i];
            if (!op) continue;
            const kind = op.kind === 'opening_balance' && sawOpening ? 'receiving_debt' : op.kind;
            if (kind === 'opening_balance') sawOpening = true;

            const hlc = makeHlc(i + 1);
            const id = makeId(i + 1);
            const createdAtMs = unixMsFromBigInt(1_780_000_000_000n + BigInt(i * 1000));
            const dueAtMs = op.overdue
              ? unixMsFromBigInt(1_781_000_000_000n)
              : unixMsFromBigInt(1_783_000_000_000n);

            if (kind === 'opening_balance' || kind === 'receiving_debt') {
              exactSum += op.amt;
              entries.push({
                id,
                hlc,
                createdAtMs,
                entryType: kind,
                amountDelta: moneyFromTiyin(op.amt),
                sourceType: kind === 'opening_balance' ? 'opening_balance' : 'receiving',
                receivingId: kind === 'receiving_debt' ? makeId(5000 + i) : null,
                paymentMethod: null,
                dueAtMs,
              });
            } else if (kind === 'adjustment_pos') {
              exactSum += op.amt;
              entries.push({
                id,
                hlc,
                createdAtMs,
                entryType: 'adjustment',
                amountDelta: moneyFromTiyin(op.amt),
                sourceType: 'adjustment',
                receivingId: null,
                paymentMethod: null,
                dueAtMs: null,
              });
            } else if (kind === 'supplier_payment' || kind === 'supplier_return') {
              exactSum -= op.amt;
              entries.push({
                id,
                hlc,
                createdAtMs,
                entryType: kind,
                amountDelta: moneyFromTiyin(-op.amt),
                sourceType: kind,
                receivingId: null,
                paymentMethod: kind === 'supplier_payment' ? 'cash' : null,
                dueAtMs: null,
              });
            } else {
              exactSum -= op.amt;
              entries.push({
                id,
                hlc,
                createdAtMs,
                entryType: 'adjustment',
                amountDelta: moneyFromTiyin(-op.amt),
                sourceType: 'adjustment',
                receivingId: null,
                paymentMethod: null,
                dueAtMs: null,
              });
            }
          }

          const forward = allocateSupplierLedgerFifo({ entries, asOfMs });
          const reversed = allocateSupplierLedgerFifo({
            entries: [...entries].reverse(),
            asOfMs,
          });

          expect(forward.balanceTiyin).toBe(exactSum);
          expect(reversed.balanceTiyin).toBe(exactSum);
          expect(forward.debtBalance).toBe(reversed.debtBalance);
          expect(forward.advanceBalance).toBe(reversed.advanceBalance);
          expect(forward.overdueAmount).toBe(reversed.overdueAmount);

          const openRemSum = forward.obligations.reduce(
            (a, b) => a + moneyToTiyin(b.remainingDebt),
            0n,
          );
          expect(openRemSum - moneyToTiyin(forward.advanceBalance)).toBe(exactSum);
          if (exactSum <= 0n) {
            expect(forward.debtBalance).toBe(ZERO_MONEY);
            expect(moneyToTiyin(forward.advanceBalance)).toBe(-exactSum);
            expect(forward.overdueAmount).toBe(ZERO_MONEY);
          } else {
            expect(forward.advanceBalance).toBe(ZERO_MONEY);
            expect(moneyToTiyin(forward.debtBalance)).toBe(exactSum);
            expect(moneyToTiyin(forward.overdueAmount) <= moneyToTiyin(forward.debtBalance)).toBe(
              true,
            );
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('produces deterministic canonical request hashes for receiving, cost confirm, supplier return and payment', () => {
    expect(
      canonicalizePostReceivingRequest({
        draftId: RCV_1,
        supplierId: SUP_1,
        supplierInvoiceNo: '  INV-99 ',
        dueDays: 14,
        linesSnapshot: [
          {
            productId: PROD_ID,
            variantId: null,
            qty: quantityFromMilli(1_000n),
            costUnknown: true,
            totalCostValue: ZERO_MONEY,
          },
        ],
      }),
    ).toBe(
      canonicalizePostReceivingRequest({
        draftId: RCV_1,
        supplierId: SUP_1,
        supplierInvoiceNo: 'INV-99',
        dueDays: 14,
        linesSnapshot: [
          {
            productId: PROD_ID,
            variantId: null,
            qty: quantityFromMilli(1_000n),
            costUnknown: true,
            totalCostValue: ZERO_MONEY,
          },
        ],
      }),
    );

    expect(
      canonicalizeConfirmReceivingCostRequest({
        receivingId: RCV_1,
        receivingLineId: BATCH_A,
        confirmedTotalCost: moneyFromTiyin(55_000n),
        reason: 'Invoice arrived',
        dueDays: 7,
      }),
    ).toContain('55000');

    expect(
      canonicalizeSupplierReturnRequest({
        receivingId: RCV_1,
        reason: 'Damaged items',
        items: [
          { receivingLineId: BATCH_B, qty: quantityFromMilli(2_000n) },
          { receivingLineId: BATCH_A, qty: quantityFromMilli(1_000n) },
        ],
      }),
    ).toBe(
      canonicalizeSupplierReturnRequest({
        receivingId: RCV_1,
        reason: 'Damaged items',
        items: [
          { receivingLineId: BATCH_A, qty: quantityFromMilli(1_000n) },
          { receivingLineId: BATCH_B, qty: quantityFromMilli(2_000n) },
        ],
      }),
    );

    expect(
      canonicalizeSupplierPaymentRequest({
        supplierId: SUP_1,
        method: 'card',
        amount: moneyFromTiyin(25_000n),
        providerRef: '  REF-7  ',
      }),
    ).toContain('REF-7');
  });
});
