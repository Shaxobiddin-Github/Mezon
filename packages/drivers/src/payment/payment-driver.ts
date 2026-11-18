/**
 * T3.6 QR payment port (UzQR first; Payme / Click / Uzum later in T4.5). The real provider API is
 * NOT known yet (T3.0): no endpoint, field or signature is invented — only what the cash register
 * must ask, and a deterministic Fake whose QR text is marked "SINOV".
 */
export interface CreateQrRequest {
  /** Our payment intent id: the provider must treat a repeated request as the same payment. */
  readonly intentId: string;
  readonly amountTiyin: bigint;
  readonly ttlMs: bigint;
}

export interface CreateQrResult {
  /** Provider's reference; stored and shown, never parsed. */
  readonly providerRef: string;
  readonly qrPayload: string;
}

export type PaymentStatusResult =
  | { readonly state: 'pending' }
  | { readonly state: 'paid'; readonly amountTiyin: bigint }
  | { readonly state: 'failed'; readonly reason: string }
  | { readonly state: 'expired' };

export type PaymentRefundResult =
  { readonly state: 'refunded' } | { readonly state: 'failed'; readonly reason: string };

/** The provider cannot be reached: the state is unknown, nothing may be assumed. */
export class PaymentUnavailableError extends Error {
  constructor(message = 'Payment provider unavailable') {
    super(message);
    this.name = 'PaymentUnavailableError';
  }
}

export interface PaymentDriver {
  readonly driverId: string;
  readonly isTestDriver: boolean;
  createQr(request: CreateQrRequest): Promise<CreateQrResult>;
  status(providerRef: string): Promise<PaymentStatusResult>;
  refund(providerRef: string, amountTiyin: bigint): Promise<PaymentRefundResult>;
}

interface FakePayment {
  amountTiyin: bigint;
  state: 'pending' | 'paid' | 'failed' | 'refunded';
}

/**
 * Deterministic test provider. Idempotent per intent id (a repeated `createQr` returns the same
 * reference). Tests drive it: `pay` (also after our local expiry = "late"), `fail`, offline.
 */
export class FakePaymentDriver implements PaymentDriver {
  public readonly driverId = 'fake';
  public readonly isTestDriver = true;
  private readonly byRef = new Map<string, FakePayment>();
  private readonly refByIntent = new Map<string, string>();
  private online = true;
  private seq = 0;

  setOnline(online: boolean): void {
    this.online = online;
  }

  pay(providerRef: string): void {
    const p = this.byRef.get(providerRef);
    if (p && p.state === 'pending') p.state = 'paid';
  }

  fail(providerRef: string): void {
    const p = this.byRef.get(providerRef);
    if (p && p.state === 'pending') p.state = 'failed';
  }

  stateOf(providerRef: string): FakePayment['state'] | undefined {
    return this.byRef.get(providerRef)?.state;
  }

  private guard(): void {
    if (!this.online) throw new PaymentUnavailableError();
  }

  createQr(request: CreateQrRequest): Promise<CreateQrResult> {
    try {
      this.guard();
    } catch (err) {
      return Promise.reject(err);
    }
    let ref = this.refByIntent.get(request.intentId);
    if (ref === undefined) {
      this.seq += 1;
      ref = `SINOV-QR-${this.seq.toString().padStart(6, '0')}`;
      this.refByIntent.set(request.intentId, ref);
      this.byRef.set(ref, { amountTiyin: request.amountTiyin, state: 'pending' });
    }
    return Promise.resolve({
      providerRef: ref,
      qrPayload: `SINOV|UZQR|${ref}|${request.amountTiyin.toString()}`,
    });
  }

  status(providerRef: string): Promise<PaymentStatusResult> {
    try {
      this.guard();
    } catch (err) {
      return Promise.reject(err);
    }
    const p = this.byRef.get(providerRef);
    if (!p) return Promise.resolve({ state: 'failed', reason: 'unknown reference' });
    if (p.state === 'paid' || p.state === 'refunded') {
      return Promise.resolve({ state: 'paid', amountTiyin: p.amountTiyin });
    }
    if (p.state === 'failed') return Promise.resolve({ state: 'failed', reason: 'declined' });
    return Promise.resolve({ state: 'pending' });
  }

  refund(providerRef: string, amountTiyin: bigint): Promise<PaymentRefundResult> {
    try {
      this.guard();
    } catch (err) {
      return Promise.reject(err);
    }
    const p = this.byRef.get(providerRef);
    if (!p || p.state !== 'paid' || p.amountTiyin !== amountTiyin) {
      return Promise.resolve({ state: 'failed', reason: 'not refundable' });
    }
    p.state = 'refunded';
    return Promise.resolve({ state: 'refunded' });
  }
}
