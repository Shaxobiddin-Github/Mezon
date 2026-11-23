import {
  type LocalSqliteConnection,
  type PaymentIntentRecord,
  appendAuditInTxSync,
  getPaymentIntentSync,
  insertPaymentIntentSync,
  listPaymentIntentsNeedingAttentionSync,
  transitionPaymentIntentSync,
} from '@mezon/db-local';
import { DomainError, type UnixMs, type UuidV7 } from '@mezon/domain';
import {
  FakePaymentDriver,
  type PaymentDriver,
  type PaymentStatusResult,
  PaymentUnavailableError,
} from '@mezon/drivers';

export interface PaymentContext {
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
}

export interface PaymentIntentDto {
  readonly id: string;
  readonly kind: 'dynamic' | 'static';
  readonly amount: string;
  readonly status: PaymentIntentRecord['status'];
  readonly providerRef: string;
  readonly qrPayload: string | null;
  readonly expiresAtMs: string;
  readonly paidLate: boolean;
  readonly consumedBySaleId: string | null;
  /** What the provider actually took (differs from `amount` only for `amount_mismatch`). */
  readonly receivedAmount: string | null;
  readonly isTestDriver: boolean;
  /** V2: the kassa may show "customer paid (demo)" for this intent. */
  readonly demoPayAllowed: boolean;
}

/** T3.6 default QR lifetime [TASDIQLANSIN]: how long the cashier waits before the QR expires. */
export const DEFAULT_QR_TTL_MS = 120_000n;

/**
 * T3.6 UzQR payment core. Rules:
 * - a sale closes with an UzQR payment ONLY through a `paid` intent (enforced in `completeSale`);
 * - the provider is called OUTSIDE any SQLite write transaction; every state change is one
 *   forward-only guarded UPDATE, so racing refreshes cannot double-apply anything;
 * - a confirmation that arrives after the local expiry (or after the cashier cancelled) becomes
 *   `paid` + `paid_late`: it can still close the sale once, or be refunded — never recorded twice;
 * - static QR (a printed shop QR): a manager confirms by hand, with a note and an audit row.
 */
export class HubPaymentService {
  constructor(
    private readonly o: {
      readonly connection: LocalSqliteConnection;
      readonly driver: PaymentDriver;
      readonly getContext: () => PaymentContext | null;
      readonly nowMs: () => UnixMs;
      readonly nextId: () => UuidV7;
      readonly ttlMs?: bigint;
      /** V2 demo mode switch (owner only); demo payments need it AND the test driver. */
      readonly isDemoMode?: () => boolean;
    },
  ) {}

  private ctx(): PaymentContext {
    const c = this.o.getContext();
    if (c === null) throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not been completed');
    return c;
  }

  private get sqlite() {
    return this.o.connection.sqlite;
  }

  private dto(r: PaymentIntentRecord): PaymentIntentDto {
    return {
      id: r.id,
      kind: r.kind,
      amount: r.amountTiyin.toString(),
      status: r.status,
      providerRef: r.providerRef,
      qrPayload: r.qrPayload,
      expiresAtMs: r.expiresAtMs.toString(),
      paidLate: r.paidLate,
      consumedBySaleId: r.consumedBySaleId,
      receivedAmount: r.receivedAmountTiyin?.toString() ?? null,
      isTestDriver: this.o.driver.isTestDriver,
      demoPayAllowed: this.o.driver instanceof FakePaymentDriver && this.o.isDemoMode?.() === true,
    };
  }

  private require(id: UuidV7): PaymentIntentRecord {
    const r = getPaymentIntentSync(this.sqlite, id);
    if (r === null || r.organizationId !== this.ctx().organizationId) {
      throw new DomainError('PAYMENT_INTENT_NOT_FOUND', 'Payment intent not found');
    }
    return r;
  }

  async create(input: {
    readonly cartId: UuidV7 | null;
    readonly amountTiyin: bigint;
    readonly kind: 'dynamic' | 'static';
  }): Promise<PaymentIntentDto> {
    const ctx = this.ctx();
    if (input.amountTiyin <= 0n)
      throw new DomainError('VALIDATION_ERROR', 'Amount must be positive');
    const id = this.o.nextId();
    const ttl = this.o.ttlMs ?? DEFAULT_QR_TTL_MS;
    let providerRef = `STATIC-${id}`;
    let qrPayload: string | null = null;
    if (input.kind === 'dynamic') {
      try {
        const qr = await this.o.driver.createQr({
          intentId: id,
          amountTiyin: input.amountTiyin,
          ttlMs: ttl,
        });
        providerRef = qr.providerRef;
        qrPayload = qr.qrPayload;
      } catch (err) {
        if (err instanceof PaymentUnavailableError) {
          throw new DomainError('NETWORK_ERROR', 'Payment provider unavailable');
        }
        throw err;
      }
    }
    const nowMs = this.o.nowMs();
    return this.dto(
      insertPaymentIntentSync(this.sqlite, {
        id,
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        cartId: input.cartId,
        kind: input.kind,
        amountTiyin: input.amountTiyin,
        providerRef,
        qrPayload,
        expiresAtMs: BigInt(nowMs) + ttl,
        nowMs,
      }),
    );
  }

  /** Asks the provider (dynamic QR) and moves the intent forward; safe to call any number of times. */
  async refresh(id: UuidV7): Promise<PaymentIntentDto> {
    let r = this.require(id);
    const nowMs = this.o.nowMs();
    if (
      r.kind === 'dynamic' &&
      ['pending', 'expired', 'cancelled', 'refunding'].includes(r.status)
    ) {
      try {
        const st = await this.o.driver.status(r.providerRef);
        if (r.status === 'refunding') this.settleRefunding(r, st, nowMs);
        else this.applyProviderStatus(r, st, nowMs);
      } catch (err) {
        if (!(err instanceof PaymentUnavailableError)) throw err;
      }
      r = this.require(id);
    }
    if (r.status === 'pending' && BigInt(nowMs) > r.expiresAtMs) {
      transitionPaymentIntentSync(this.sqlite, { id, from: ['pending'], to: 'expired', nowMs });
      r = this.require(id);
    }
    return this.dto(r);
  }

  private applyProviderStatus(
    r: PaymentIntentRecord,
    st: PaymentStatusResult,
    nowMs: UnixMs,
  ): void {
    const id = r.id;
    if (st.state === 'paid' && st.amountTiyin === r.amountTiyin) {
      if (
        !transitionPaymentIntentSync(this.sqlite, {
          id,
          from: ['pending'],
          to: 'paid',
          nowMs,
          receivedAmountTiyin: st.amountTiyin,
        })
      ) {
        transitionPaymentIntentSync(this.sqlite, {
          id,
          from: ['expired', 'cancelled'],
          to: 'paid',
          nowMs,
          paidLate: true,
          receivedAmountTiyin: st.amountTiyin,
        });
      }
    } else if (st.state === 'paid') {
      // P2-K2: money was taken, but not the sum on the QR. It never closes a receipt; a manager sees
      // it (GET /payments/intents/attention) and refunds it. Status + audit row in one transaction.
      this.sqlite.transaction(() => {
        const moved = transitionPaymentIntentSync(this.sqlite, {
          id,
          from: ['pending', 'expired', 'cancelled'],
          to: 'amount_mismatch',
          nowMs,
          paidLate: r.status !== 'pending',
          receivedAmountTiyin: st.amountTiyin,
        });
        if (moved) {
          appendAuditInTxSync(this.sqlite, {
            organizationId: r.organizationId,
            eventType: 'payment.amount_mismatch',
            actorUserId: null,
            entity: 'payment_intents',
            entityId: id,
            details: {
              expected: r.amountTiyin.toString(),
              received: st.amountTiyin.toString(),
              providerRef: r.providerRef,
            },
            nowMs,
            nextId: this.o.nextId,
          });
        }
      })();
    } else if (st.state === 'failed') {
      transitionPaymentIntentSync(this.sqlite, { id, from: ['pending'], to: 'failed', nowMs });
    }
  }

  /** The status a `refunding` intent returns to when the provider clearly refuses the refund. */
  private beforeRefund(r: PaymentIntentRecord): 'paid' | 'amount_mismatch' {
    return r.receivedAmountTiyin !== null && r.receivedAmountTiyin !== r.amountTiyin
      ? 'amount_mismatch'
      : 'paid';
  }

  /** `refunding → refunded` plus its audit row, in one transaction (only the first caller writes). */
  private finishRefund(
    r: PaymentIntentRecord,
    nowMs: UnixMs,
    actorUserId: UuidV7 | null,
    settledBy: 'refund_answer' | 'provider_status',
  ): void {
    this.sqlite.transaction(() => {
      if (
        transitionPaymentIntentSync(this.sqlite, {
          id: r.id,
          from: ['refunding'],
          to: 'refunded',
          nowMs,
        })
      ) {
        appendAuditInTxSync(this.sqlite, {
          organizationId: r.organizationId,
          eventType: 'payment.refunded',
          actorUserId,
          entity: 'payment_intents',
          entityId: r.id,
          details: { amount: (r.receivedAmountTiyin ?? r.amountTiyin).toString(), settledBy },
          nowMs,
          nextId: this.o.nextId,
        });
      }
    })();
  }

  /**
   * P2-K1: an open refund is closed only when the provider reports the money returned. A provider
   * still saying "paid" does NOT reopen the QR: our refund request may still be on its way. The
   * manager retries the refund instead (the driver contract makes a refund idempotent per reference).
   */
  private settleRefunding(r: PaymentIntentRecord, st: PaymentStatusResult, nowMs: UnixMs): void {
    if (st.state === 'refunded') this.finishRefund(r, nowMs, null, 'provider_status');
  }

  /** Manager view (P2-K2): wrong-sum payments and refunds whose outcome is still open. */
  needingAttention(): PaymentIntentDto[] {
    return listPaymentIntentsNeedingAttentionSync(this.sqlite, this.ctx().organizationId).map((r) =>
      this.dto(r),
    );
  }

  /**
   * V2 demo: "the customer paid" for a dynamic QR of the TEST provider, so the whole QR flow can be
   * shown without a real provider. Only in demo mode (owner switch) and only with the test driver;
   * a real driver can never be told that money arrived. Every use leaves an audit row.
   */
  async demoPay(id: UuidV7, userId: UuidV7): Promise<PaymentIntentDto> {
    const driver = this.o.driver;
    if (!(driver instanceof FakePaymentDriver) || this.o.isDemoMode?.() !== true) {
      throw new DomainError('PAYMENT_INTENT_INVALID_STATE', 'Demo payments are off');
    }
    const r = this.require(id);
    if (r.kind !== 'dynamic' || r.status !== 'pending') {
      throw new DomainError('PAYMENT_INTENT_INVALID_STATE', 'Only a waiting QR can be paid');
    }
    driver.pay(r.providerRef);
    const nowMs = this.o.nowMs();
    this.sqlite.transaction(() => {
      appendAuditInTxSync(this.sqlite, {
        organizationId: r.organizationId,
        eventType: 'payment.demo_paid',
        actorUserId: userId,
        entity: 'payment_intents',
        entityId: id,
        details: { amount: r.amountTiyin.toString(), providerRef: r.providerRef },
        nowMs,
        nextId: this.o.nextId,
      });
    })();
    return this.refresh(id);
  }

  cancel(id: UuidV7): PaymentIntentDto {
    this.require(id);
    if (
      !transitionPaymentIntentSync(this.sqlite, {
        id,
        from: ['pending', 'expired'],
        to: 'cancelled',
        nowMs: this.o.nowMs(),
      })
    ) {
      throw new DomainError(
        'PAYMENT_INTENT_INVALID_STATE',
        'Only a pending or expired QR can be cancelled',
      );
    }
    return this.dto(this.require(id));
  }

  /** Static QR: a manager saw the money arrive and confirms by hand (note + audit, one tx). */
  confirmStatic(id: UuidV7, userId: UuidV7, note: string): PaymentIntentDto {
    const r = this.require(id);
    if (r.kind !== 'static') {
      throw new DomainError(
        'PAYMENT_INTENT_INVALID_STATE',
        'Only a static QR is confirmed by hand',
      );
    }
    const nowMs = this.o.nowMs();
    const ok = this.sqlite.transaction(() => {
      const moved = transitionPaymentIntentSync(this.sqlite, {
        id,
        from: ['pending', 'expired'],
        to: 'paid',
        nowMs,
        paidLate: r.status === 'expired',
        confirmedByUserId: userId,
        confirmNote: note,
        receivedAmountTiyin: r.amountTiyin,
      });
      if (moved) {
        appendAuditInTxSync(this.sqlite, {
          organizationId: r.organizationId,
          eventType: 'payment.manual_confirmed',
          actorUserId: userId,
          entity: 'payment_intents',
          entityId: id,
          details: { amount: r.amountTiyin.toString(), note },
          nowMs,
          nextId: this.o.nextId,
        });
      }
      return moved;
    })();
    if (!ok)
      throw new DomainError('PAYMENT_INTENT_INVALID_STATE', 'This QR payment cannot be confirmed');
    return this.dto(this.require(id));
  }

  /**
   * A paid (or wrong-sum) intent no sale used: money goes back. P2-K1 order: claim locally FIRST
   * (`paid → refunding`, guarded by `consumed_by_sale_id IS NULL`), so a sale can no longer use the
   * QR, THEN ask the provider. Its answer decides: refunded → `refunded`; a clear refusal → back;
   * no answer (offline, timeout) → stays `refunding` (shown to the manager). Calling this again on a
   * `refunding` intent retries the same refund; the provider treats it as the same refund.
   */
  async refund(id: UuidV7, userId: UuidV7): Promise<PaymentIntentDto> {
    const r = this.require(id);
    if (
      r.consumedBySaleId !== null ||
      !['paid', 'amount_mismatch', 'refunding'].includes(r.status)
    ) {
      throw new DomainError(
        'PAYMENT_INTENT_INVALID_STATE',
        'Only a paid, unused QR payment can be refunded',
      );
    }
    const restoreTo = r.status === 'refunding' ? this.beforeRefund(r) : r.status;
    if (
      r.status !== 'refunding' &&
      !transitionPaymentIntentSync(this.sqlite, {
        id,
        from: [r.status],
        to: 'refunding',
        nowMs: this.o.nowMs(),
      })
    ) {
      throw new DomainError(
        'PAYMENT_INTENT_INVALID_STATE',
        'The payment was used by a sale or refunded meanwhile',
      );
    }
    if (r.kind === 'dynamic') {
      let res;
      try {
        res = await this.o.driver.refund(r.providerRef, r.receivedAmountTiyin ?? r.amountTiyin);
      } catch (err) {
        // The money's fate is unknown: keep `refunding` (no sale can use it).
        if (err instanceof PaymentUnavailableError) {
          throw new DomainError(
            'NETWORK_ERROR',
            'Payment provider unavailable; the refund stays open until the provider answers',
          );
        }
        throw err;
      }
      if (res.state !== 'refunded') {
        // A clear refusal: the money is still ours, the QR is usable again.
        transitionPaymentIntentSync(this.sqlite, {
          id,
          from: ['refunding'],
          to: restoreTo,
          nowMs: this.o.nowMs(),
        });
        throw new DomainError(
          'PAYMENT_INTENT_INVALID_STATE',
          `Provider refused the refund: ${res.reason}`,
        );
      }
    }
    this.finishRefund(r, this.o.nowMs(), userId, 'refund_answer');
    return this.dto(this.require(id));
  }
}
