/**
 * T3.3 fiscal core — pure, driver-agnostic model.
 *
 * Nothing here knows a real fiscal operator, virtual cash register, OFD protocol, endpoint or field
 * name (§3.3: no documentation → nothing invented). Driver answers (sign, number, QR text) are
 * OPAQUE strings: stored and printed verbatim, never parsed.
 */

/** Every fiscal document state. `confirmed` and `cancelled` are terminal. */
export const FISCAL_DOC_STATUSES = [
  'pending',
  'sent',
  'confirmed',
  'failed',
  'rejected',
  'cancelled',
] as const;
export type FiscalDocStatus = (typeof FISCAL_DOC_STATUSES)[number];

/**
 * Document kinds. Shift open/close go through the same queue so the Z-report also follows the
 * "commit `sent` first, then ask `status()`" rule (controller fix #4).
 */
export const FISCAL_DOC_KINDS = ['sale', 'refund', 'shift_open', 'shift_close'] as const;
export type FiscalDocKind = (typeof FISCAL_DOC_KINDS)[number];

/**
 * THE single transition table. SQLite triggers (db-local) and the cloud MONOTONE rule (contracts)
 * are both derived from / tested against it (`monotone-parity.test.ts`).
 *
 * - `sent → failed` is ONLY for a definitely-not-fiscalized outcome (the driver refused before the
 *   request left, or `status()` answered "no such key"). An unknown outcome (timeout, 5xx, lost
 *   reply) keeps the document in `sent`; the next step is `status()` only (controller F-A).
 * - `rejected → cancelled`: a rejected receipt is not fiscal; void moves it to `cancelled` (S2).
 * - `sent → cancelled` does NOT exist: the operator may already hold the receipt (S5).
 */
export const FISCAL_DOC_TRANSITIONS: Readonly<Record<FiscalDocStatus, readonly FiscalDocStatus[]>> =
  {
    pending: ['sent', 'cancelled'],
    sent: ['confirmed', 'rejected', 'failed'],
    failed: ['sent', 'cancelled'],
    rejected: ['cancelled'],
    confirmed: [],
    cancelled: [],
  };

/** Non-terminal states whose bookkeeping columns (attempts, next check, last error) may change in place. */
export const FISCAL_DOC_BOOKKEEPING_STATES: readonly FiscalDocStatus[] = [
  'pending',
  'sent',
  'failed',
];

export function isFiscalDocStatus(v: unknown): v is FiscalDocStatus {
  return typeof v === 'string' && (FISCAL_DOC_STATUSES as readonly string[]).includes(v);
}

export function isFiscalDocTransitionAllowed(from: FiscalDocStatus, to: FiscalDocStatus): boolean {
  return FISCAL_DOC_TRANSITIONS[from].includes(to);
}

/** States that still need the driver (count toward the offline deadline warning). */
export const FISCAL_DOC_UNSETTLED_STATES: readonly FiscalDocStatus[] = [
  'pending',
  'sent',
  'failed',
];

/** Void decision for a sale's fiscal document (controller table, S2/S5). */
export function canVoidWithFiscalStatus(status: FiscalDocStatus | null): boolean {
  if (status === null) return true; // fiscal mode was off at sale time: nothing fiscal exists
  return status === 'pending' || status === 'failed' || status === 'rejected';
}

/** Receipt fiscal field keys that a configuration may request (opaque driver values + TIN). */
export const FISCAL_RECEIPT_FIELD_KEYS = [
  'fiscalSign',
  'fiscalNumber',
  'confirmedAt',
  'driverId',
  'organizationTin',
] as const;
export type FiscalReceiptFieldKey = (typeof FISCAL_RECEIPT_FIELD_KEYS)[number];

export interface FiscalReceiptFieldConfig {
  readonly key: FiscalReceiptFieldKey;
  readonly label: string;
}

/** Banner printed on the receipt (T3.4). Strings are i18n-free printer constants. */
export type ReceiptFiscalMark = 'FISCAL' | 'FISCAL_INCOMPLETE' | 'FISCAL_PENDING' | 'NOT_FISCAL';

export interface ReceiptFiscalInput {
  /** `null` = no fiscal document (fiscal mode was off for this sale). */
  readonly status: FiscalDocStatus | null;
  readonly values: Readonly<Partial<Record<FiscalReceiptFieldKey, string | null>>>;
  readonly qrPayload: string | null;
  readonly fields: readonly FiscalReceiptFieldConfig[];
  /** Test driver in use: the receipt additionally keeps "SINOV — FISKAL EMAS" (§3.3). */
  readonly isTestDriver: boolean;
}

export interface ReceiptFiscalBlock {
  readonly mark: ReceiptFiscalMark;
  readonly testBanner: boolean;
  /** Label/value rows, only when `mark === 'FISCAL'`. */
  readonly rows: readonly { readonly label: string; readonly value: string }[];
  /** QR text printed verbatim, only when `mark === 'FISCAL'`. */
  readonly qrPayload: string | null;
}

/**
 * T3.4 mark rule. "FISCAL" only when the document is confirmed AND every configured field AND the
 * QR text are present; an empty configuration can never produce a fiscal receipt.
 */
export function resolveReceiptFiscalBlock(input: ReceiptFiscalInput): ReceiptFiscalBlock {
  const base = { testBanner: input.isTestDriver, rows: [], qrPayload: null } as const;
  if (input.status === null || input.status === 'rejected' || input.status === 'cancelled') {
    return { ...base, mark: 'NOT_FISCAL' };
  }
  if (input.status !== 'confirmed') {
    return { ...base, mark: 'FISCAL_PENDING' };
  }
  const rows: { label: string; value: string }[] = [];
  let complete = input.fields.length > 0 && input.qrPayload !== null && input.qrPayload !== '';
  for (const f of input.fields) {
    const v = input.values[f.key];
    if (v === null || v === undefined || v.trim() === '') {
      complete = false;
    } else {
      rows.push({ label: f.label, value: v });
    }
  }
  if (!complete) {
    return { ...base, mark: 'FISCAL_INCOMPLETE' };
  }
  return { ...base, mark: 'FISCAL', rows, qrPayload: input.qrPayload };
}
