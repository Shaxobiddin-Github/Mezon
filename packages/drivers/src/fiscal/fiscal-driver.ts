import type { FiscalDocKind } from '@mezon/domain';

/**
 * T3.3 fiscal driver PORT. Deliberately minimal: no operator, OFD protocol, endpoint or field name
 * is modelled (§3.3, no documentation). A real driver (T3.5) maps its own protocol onto this port;
 * until then only `FakeFiscalDriver` exists.
 */
export interface FiscalSubmitRequest {
  readonly kind: FiscalDocKind;
  /** Stable per document (`sale.id`, `return.id`, `shift.id:open|close`). The driver dedupes on it. */
  readonly idempotencyKey: string;
  readonly docId: string;
  readonly saleId: string | null;
  readonly returnId: string | null;
  readonly shiftId: string | null;
}

/** Opaque driver answer: stored and printed verbatim, never parsed. */
export interface FiscalConfirmation {
  readonly fiscalSign: string;
  readonly fiscalNumber: string;
  readonly qrPayload: string;
}

export type FiscalSubmitResult =
  | { readonly outcome: 'confirmed'; readonly confirmation: FiscalConfirmation }
  | { readonly outcome: 'rejected'; readonly code: string; readonly message: string };

/**
 * `notFound` MUST be final for the given key (the operator will never process it later). For the
 * real operator this is verified against its documentation in T3.5 (controller F-A note).
 */
export type FiscalStatusResult =
  | { readonly state: 'confirmed'; readonly confirmation: FiscalConfirmation }
  | { readonly state: 'rejected'; readonly code: string; readonly message: string }
  | { readonly state: 'notFound' };

/**
 * Driver failure classification (controller F-A):
 * - `definitelyNotSent`: the request never left (no connection, refused locally) → the document is
 *   certainly not fiscalized; a new `submit` is safe.
 * - `outcomeUnknown`: timeout, 5xx, lost reply → the operator MAY hold the receipt; the document
 *   stays `sent` and only `status()` may follow.
 */
export type FiscalDriverErrorKind = 'definitelyNotSent' | 'outcomeUnknown';

export class FiscalDriverError extends Error {
  public readonly kind: FiscalDriverErrorKind;
  public readonly code: string;

  public constructor(kind: FiscalDriverErrorKind, code: string, message: string) {
    super(message);
    this.name = 'FiscalDriverError';
    this.kind = kind;
    this.code = code;
  }
}

export function isFiscalDriverError(err: unknown): err is FiscalDriverError {
  return err instanceof FiscalDriverError;
}

export interface FiscalDriver {
  readonly driverId: string;
  /** Test driver: receipts keep "SINOV — FISKAL EMAS" whatever the document state (§3.3). */
  readonly isTestDriver: boolean;
  submit(request: FiscalSubmitRequest): Promise<FiscalSubmitResult>;
  status(idempotencyKey: string): Promise<FiscalStatusResult>;
  /** Liveness probe used by the fiscal-mode preconditions. Throws `FiscalDriverError` when down. */
  ping(): Promise<void>;
}
