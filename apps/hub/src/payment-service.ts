import {
  type LocalSqliteConnection,
  type PaymentIntentRecord,
  appendAuditInTxSync,
  getPaymentIntentSync,
  insertPaymentIntentSync,
  transitionPaymentIntentSync,
} from '@mezon/db-local';
import { DomainError, type UnixMs, type UuidV7 } from '@mezon/domain';
import { type PaymentDriver, PaymentUnavailableError } from '@mezon/drivers';

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
  readonly isTestDriver: boolean;
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
      isTestDriver: this.o.driver.isTestDriver,
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
    if (r.kind === 'dynamic' && ['pending', 'expired', 'cancelled'].includes(r.status)) {
      try {
        const st = await this.o.driver.status(r.providerRef);
        if (st.state === 'paid' && st.amountTiyin === r.amountTiyin) {
          if (
            !transitionPaymentIntentSync(this.sqlite, { id, from: ['pending'], to: 'paid', nowMs })
          ) {
            transitionPaymentIntentSync(this.sqlite, {
              id,
              from: ['expired', 'cancelled'],
              to: 'paid',
              nowMs,
              paidLate: true,
            });
          }
        } else if (st.state === 'failed') {
          transitionPaymentIntentSync(this.sqlite, { id, from: ['pending'], to: 'failed', nowMs });
        }
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

  /** A paid intent no sale used (late confirmation, changed payment method): money goes back. */
  async refund(id: UuidV7): Promise<PaymentIntentDto> {
    const r = this.require(id);
    if (r.status !== 'paid' || r.consumedBySaleId !== null) {
      throw new DomainError(
        'PAYMENT_INTENT_INVALID_STATE',
        'Only a paid, unused QR payment can be refunded',
      );
    }
    if (r.kind === 'dynamic') {
      let res;
      try {
        res = await this.o.driver.refund(r.providerRef, r.amountTiyin);
      } catch (err) {
        if (err instanceof PaymentUnavailableError) {
          throw new DomainError('NETWORK_ERROR', 'Payment provider unavailable');
        }
        throw err;
      }
      if (res.state !== 'refunded') {
        throw new DomainError(
          'PAYMENT_INTENT_INVALID_STATE',
          `Provider refused the refund: ${res.reason}`,
        );
      }
    }
    if (
      !transitionPaymentIntentSync(this.sqlite, {
        id,
        from: ['paid'],
        to: 'refunded',
        nowMs: this.o.nowMs(),
      })
    ) {
      throw new DomainError(
        'PAYMENT_INTENT_INVALID_STATE',
        'The payment was used by a sale meanwhile',
      );
    }
    return this.dto(this.require(id));
  }
}
