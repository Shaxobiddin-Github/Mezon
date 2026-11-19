import {
  type FiscalConfirmation,
  type FiscalDriver,
  FiscalDriverError,
  type FiscalStatusResult,
  type FiscalSubmitRequest,
  type FiscalSubmitResult,
} from './fiscal-driver.js';

/**
 * Behaviour of the next `submit` call:
 * - `ok`: accept and confirm.
 * - `reject`: the operator refuses the receipt (recorded; `status()` answers `rejected`).
 * - `offline`: `definitelyNotSent` — nothing reaches the ledger.
 * - `timeout`: `outcomeUnknown` — nothing reaches the ledger (lost request).
 * - `throw-after-accept`: accepted and recorded in the ledger, then `outcomeUnknown` (lost reply).
 */
export type FakeFiscalSubmitMode = 'ok' | 'reject' | 'offline' | 'timeout' | 'throw-after-accept';
/** Behaviour of `status()` / `ping()`: answer, or fail with `outcomeUnknown`. */
export type FakeFiscalStatusMode = 'ok' | 'offline';

export interface FakeFiscalLedgerEntry {
  readonly result: FiscalSubmitResult;
  /** Times `submit` reached the operator for this key (the double-fiscalization witness). */
  readonly submitCount: number;
}

/** Operator-side state of a fiscal shift (the operator, not the hub, is the authority). */
export type FakeFiscalShiftState = 'open' | 'closed';

export interface FakeFiscalLedger {
  readonly seq: number;
  readonly entries: Readonly<Record<string, FakeFiscalLedgerEntry>>;
  /** Shift states as the operator knows them. Optional: older ledger files have none. */
  readonly shifts?: Readonly<Record<string, FakeFiscalShiftState>>;
}

/** Ledger persistence. In-memory by default; `drivers/node` offers a file-backed one for crash tests. */
export interface FakeFiscalLedgerStore {
  read(): FakeFiscalLedger;
  write(ledger: FakeFiscalLedger): void;
}

export class InMemoryFakeFiscalLedgerStore implements FakeFiscalLedgerStore {
  private ledger: FakeFiscalLedger = { seq: 0, entries: {} };
  public read(): FakeFiscalLedger {
    return this.ledger;
  }
  public write(ledger: FakeFiscalLedger): void {
    this.ledger = ledger;
  }
}

export interface FakeFiscalDriverOptions {
  readonly ledgerStore?: FakeFiscalLedgerStore;
  readonly submitMode?: FakeFiscalSubmitMode;
  readonly statusMode?: FakeFiscalStatusMode;
  /** Optional hook invoked after a `throw-after-accept` submit is recorded (crash test (b)). */
  readonly onAcceptedBeforeReply?: () => void;
  /** Simulated network latency for every submit / status / ping call (perf tests). */
  readonly latencyMs?: number;
}

/**
 * Deterministic test fiscal driver (§3.3). Signs are `SINOV-…`, QR text `SINOV|…`; nothing imitates
 * a real operator format. Idempotent per key: a repeated `submit` returns the FIRST result, never a
 * new sign, and increments `submitCount` (tests assert it stays ≤ 1).
 *
 * P1: it enforces the operator's shift invariants like a real operator would, so an ordering bug in
 * the hub queue surfaces in every test, not only in the dedicated ones. When a request names its
 * shift (`shiftId`):
 * - a receipt (`sale` / `refund`) for a shift the operator never opened → `rejected` (SHIFT_NOT_OPEN);
 * - a receipt for a shift already closed (Z done) → `rejected` (SHIFT_CLOSED);
 * - closing a shift that is not open → `rejected` (SHIFT_NOT_OPEN).
 */
export class FakeFiscalDriver implements FiscalDriver {
  public readonly driverId = 'fake';
  public readonly isTestDriver = true;
  private readonly store: FakeFiscalLedgerStore;
  private submitMode: FakeFiscalSubmitMode;
  private statusMode: FakeFiscalStatusMode;
  private readonly queuedModes: FakeFiscalSubmitMode[] = [];
  private readonly onAcceptedBeforeReply: (() => void) | undefined;
  private attemptsTotal = 0;
  private readonly latencyMs: number;

  public constructor(options: FakeFiscalDriverOptions = {}) {
    this.store = options.ledgerStore ?? new InMemoryFakeFiscalLedgerStore();
    this.submitMode = options.submitMode ?? 'ok';
    this.statusMode = options.statusMode ?? 'ok';
    this.onAcceptedBeforeReply = options.onAcceptedBeforeReply;
    this.latencyMs = options.latencyMs ?? 0;
  }

  private delay<T>(run: () => Promise<T>): Promise<T> {
    if (this.latencyMs <= 0) return run();
    return new Promise<void>((resolve) => setTimeout(resolve, this.latencyMs)).then(run);
  }

  public setSubmitMode(mode: FakeFiscalSubmitMode): void {
    this.submitMode = mode;
  }

  /** Modes consumed one per `submit` before falling back to the sticky `submitMode`. */
  public queueSubmitModes(...modes: FakeFiscalSubmitMode[]): void {
    this.queuedModes.push(...modes);
  }

  public setStatusMode(mode: FakeFiscalStatusMode): void {
    this.statusMode = mode;
  }

  /** Times `submit` reached the operator for a key (0 when never). */
  public submitCount(idempotencyKey: string): number {
    return this.store.read().entries[idempotencyKey]?.submitCount ?? 0;
  }

  /** Every `submit` call, including ones that never reached the ledger. */
  public totalSubmitAttempts(): number {
    return this.attemptsTotal;
  }

  /**
   * Keys the operator refused because of the shift order (SHIFT_NOT_OPEN / SHIFT_CLOSED). A correct
   * hub queue never produces one, so hub tests assert this stays empty after every test.
   */
  public shiftOrderViolations(): readonly string[] {
    return Object.entries(this.store.read().entries)
      .filter(
        ([, e]) =>
          e.result.outcome === 'rejected' &&
          (e.result.code === 'SHIFT_NOT_OPEN' || e.result.code === 'SHIFT_CLOSED'),
      )
      .map(([k]) => k);
  }

  public ledgerKeys(): readonly string[] {
    return Object.keys(this.store.read().entries);
  }

  public submit(request: FiscalSubmitRequest): Promise<FiscalSubmitResult> {
    this.attemptsTotal += 1;
    return this.delay(() => this.submitNow(request));
  }

  private submitNow(request: FiscalSubmitRequest): Promise<FiscalSubmitResult> {
    const mode = this.queuedModes.shift() ?? this.submitMode;
    if (mode === 'offline') {
      return Promise.reject(
        new FiscalDriverError('definitelyNotSent', 'FAKE_OFFLINE', 'Sinov drayveri: ulanish yo‘q'),
      );
    }
    if (mode === 'timeout') {
      return Promise.reject(
        new FiscalDriverError('outcomeUnknown', 'FAKE_TIMEOUT', 'Sinov drayveri: javob kelmadi'),
      );
    }
    const ledger = this.store.read();
    const existing = ledger.entries[request.idempotencyKey];
    let result: FiscalSubmitResult;
    if (existing !== undefined) {
      result = existing.result;
      this.store.write({
        seq: ledger.seq,
        shifts: ledger.shifts ?? {},
        entries: {
          ...ledger.entries,
          [request.idempotencyKey]: { result, submitCount: existing.submitCount + 1 },
        },
      });
    } else {
      const seq = ledger.seq + 1;
      const shifts = { ...(ledger.shifts ?? {}) };
      const violation = mode === 'reject' ? null : shiftViolation(request, shifts);
      if (mode === 'reject') {
        result = { outcome: 'rejected', code: 'FAKE_REJECTED', message: 'Sinov drayveri rad etdi' };
      } else if (violation !== null) {
        result = violation;
      } else {
        result = {
          outcome: 'confirmed',
          confirmation: fakeConfirmation(request.idempotencyKey, seq),
        };
        if (request.shiftId !== null) {
          if (request.kind === 'shift_open') shifts[request.shiftId] = 'open';
          if (request.kind === 'shift_close') shifts[request.shiftId] = 'closed';
        }
      }
      this.store.write({
        seq,
        entries: { ...ledger.entries, [request.idempotencyKey]: { result, submitCount: 1 } },
        shifts,
      });
    }
    if (mode === 'throw-after-accept') {
      this.onAcceptedBeforeReply?.();
      return Promise.reject(
        new FiscalDriverError(
          'outcomeUnknown',
          'FAKE_REPLY_LOST',
          'Sinov drayveri: javob yo‘qoldi',
        ),
      );
    }
    return Promise.resolve(result);
  }

  public status(idempotencyKey: string): Promise<FiscalStatusResult> {
    return this.delay(() => this.statusNow(idempotencyKey));
  }

  private statusNow(idempotencyKey: string): Promise<FiscalStatusResult> {
    if (this.statusMode === 'offline') {
      return Promise.reject(
        new FiscalDriverError('outcomeUnknown', 'FAKE_OFFLINE', 'Sinov drayveri: ulanish yo‘q'),
      );
    }
    const entry = this.store.read().entries[idempotencyKey];
    if (entry === undefined) return Promise.resolve({ state: 'notFound' });
    return Promise.resolve(
      entry.result.outcome === 'confirmed'
        ? { state: 'confirmed', confirmation: entry.result.confirmation }
        : { state: 'rejected', code: entry.result.code, message: entry.result.message },
    );
  }

  public ping(): Promise<void> {
    if (this.statusMode === 'offline') {
      return Promise.reject(
        new FiscalDriverError('outcomeUnknown', 'FAKE_OFFLINE', 'Sinov drayveri: ulanish yo‘q'),
      );
    }
    return Promise.resolve();
  }
}

function shiftViolation(
  request: FiscalSubmitRequest,
  shifts: Readonly<Record<string, FakeFiscalShiftState>>,
): FiscalSubmitResult | null {
  if (request.shiftId === null || request.kind === 'shift_open') return null;
  const state = shifts[request.shiftId];
  if (state === 'open') return null;
  if (state === 'closed' && request.kind !== 'shift_close') {
    return {
      outcome: 'rejected',
      code: 'SHIFT_CLOSED',
      message: 'Sinov drayveri: smena yopilgan, chek qabul qilinmaydi',
    };
  }
  return {
    outcome: 'rejected',
    code: 'SHIFT_NOT_OPEN',
    message: 'Sinov drayveri: smena ochilmagan',
  };
}

function fakeConfirmation(key: string, seq: number): FiscalConfirmation {
  const n = seq.toString().padStart(6, '0');
  return {
    fiscalSign: `SINOV-FB-${n}`,
    fiscalNumber: `SINOV-FD-${n}`,
    qrPayload: `SINOV|${key}|${n}`,
  };
}
