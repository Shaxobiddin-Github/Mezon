import type { SqliteFiscalStore, StoredFiscalDocRecord } from '@mezon/db-local';
import { type FiscalDriver, type FiscalSubmitResult, isFiscalDriverError } from '@mezon/drivers';
import { DomainError } from '@mezon/domain';
import type { Logger } from 'pino';

export interface HubFiscalWorkerOptions {
  readonly store: SqliteFiscalStore;
  readonly driver: FiscalDriver;
  readonly nowMs: () => bigint;
  readonly logger?: Logger;
  /** When a `sent` document is next asked about via `status()` (crash / lost reply). */
  readonly statusRecheckMs?: bigint;
  readonly minBackoffMs?: bigint;
  readonly maxBackoffMs?: bigint;
  /** Max documents per pass; a full pass schedules the next one immediately. */
  readonly batchSize?: number;
  /**
   * Test-only seam: invoked right after `sent` is COMMITTED and before the driver call
   * (crash test (a), mutation F1). Never wired in production.
   */
  readonly __afterSentCommitted?: (doc: StoredFiscalDocRecord) => void;
}

export interface FiscalWorkerRunResult {
  readonly processed: number;
  readonly confirmed: number;
  readonly rejected: number;
  readonly failed: number;
  readonly unknown: number;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type Outcome = 'confirmed' | 'rejected' | 'failed' | 'unknown' | 'waiting' | 'cancelled';

/**
 * T3.3 fiscal queue worker (T2.3 `HubSyncPushWorker` pattern: `setTimeout`, backoff, `stop()`).
 *
 * Double-fiscalization proof (with `FakeFiscalDriver` / any idempotent operator):
 * 1. `pending|failed → sent` is committed in its OWN transaction BEFORE `driver.submit`.
 * 2. A `sent` document is NEVER submitted again; it is resumed only through `driver.status()`.
 * 3. `failed` means "definitely not fiscalized" (request never left, or `status()` = notFound);
 *    only then is a new `submit` safe. Unknown outcomes stay `sent` (controller F-A).
 * 4. One worker per hub; `inFlight` serializes runs, so one document is handled at a time.
 */
export class HubFiscalWorker {
  private readonly opts: HubFiscalWorkerOptions;
  private readonly statusRecheckMs: bigint;
  private readonly minBackoffMs: bigint;
  private readonly maxBackoffMs: bigint;
  private readonly batchSize: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight: Promise<FiscalWorkerRunResult> | null = null;

  constructor(opts: HubFiscalWorkerOptions) {
    this.opts = opts;
    this.statusRecheckMs = opts.statusRecheckMs ?? 30_000n;
    this.minBackoffMs = opts.minBackoffMs ?? 5_000n;
    this.maxBackoffMs = opts.maxBackoffMs ?? 300_000n;
    this.batchSize = opts.batchSize ?? 50;
  }

  start(intervalMs = 3000): void {
    if (this.running) return;
    this.running = true;
    const next = (delayMs: number) => {
      if (!this.running) return;
      this.timer = setTimeout(() => {
        let full = false;
        void this.runOnce()
          .then((r) => {
            full = r.processed >= this.batchSize;
          })
          .catch((err: unknown) =>
            this.opts.logger?.error(
              { event: 'fiscal.worker_error', err },
              'Fiscal worker run failed',
            ),
          )
          // A backlog (after an outage) drains pass after pass without the idle interval.
          .finally(() => next(full ? 0 : intervalMs));
      }, delayMs);
    };
    next(intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Non-blocking nudge (after a sale or a manager retry). Never awaited by the caller. */
  kick(): void {
    void this.runOnce().catch((err: unknown) =>
      this.opts.logger?.error({ event: 'fiscal.worker_error', err }, 'Fiscal worker kick failed'),
    );
  }

  /** Runs one pass. Concurrent callers share the same in-flight pass (single worker). */
  runOnce(): Promise<FiscalWorkerRunResult> {
    if (this.inFlight !== null) return this.inFlight;
    const run = this.pass().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  /**
   * S1 backlog drain (owner: "must not freeze"): strictly ONE document at a time, oldest first;
   * every state change is its own short transaction, the driver call is never inside one, and the
   * event loop gets a turn between documents so sales are never starved by a large queue.
   * The head blocks the queue until it settles, which keeps the S4 / S3 order.
   */
  private async pass(): Promise<FiscalWorkerRunResult> {
    const counts = { processed: 0, confirmed: 0, rejected: 0, failed: 0, unknown: 0 };
    // Oldest first. A document waiting for a dependency (shift open, its receipts, the sale of a
    // refund) never blocks the others — the explicit gates keep the order — so nothing can deadlock
    // (e.g. a Z created "earlier" after a clock correction).
    for (const queued of this.opts.store.queueSync(this.batchSize * 4)) {
      if (counts.processed >= this.batchSize) break;
      if (BigInt(queued.nextCheckAtMs) > this.opts.nowMs()) continue;
      const doc = this.opts.store.getDocSync(queued.id); // fresh state (void may have cancelled it)
      if (
        doc === null ||
        (doc.status !== 'pending' && doc.status !== 'sent' && doc.status !== 'failed')
      ) {
        continue;
      }
      let outcome: Outcome;
      try {
        outcome = await this.process(doc);
      } catch (err) {
        if (err instanceof DomainError && err.code === 'FISCAL_DOC_INVALID_STATE') continue;
        throw err;
      }
      if (outcome === 'waiting') continue;
      counts.processed += 1;
      if (outcome === 'confirmed') counts.confirmed += 1;
      else if (outcome === 'rejected') counts.rejected += 1;
      else if (outcome === 'failed') counts.failed += 1;
      else if (outcome === 'unknown') counts.unknown += 1;
      // Driver trouble: stop this pass; the backoff decides when to try again.
      if (outcome === 'failed' || outcome === 'unknown') break;
      await yieldToEventLoop();
    }
    return counts;
  }

  /** Records why a document waits — written only when the reason changes (no outbox churn). */
  private async noteWaiting(doc: StoredFiscalDocRecord, code: string, message: string) {
    if (doc.lastErrorCode === code) return;
    await this.opts.store.reschedule(doc, BigInt(doc.nextCheckAtMs), code, message);
  }

  private backoff(attempts: number): bigint {
    let delay = this.minBackoffMs;
    for (let i = 1; i < attempts && delay < this.maxBackoffMs; i += 1) delay *= 2n;
    return delay > this.maxBackoffMs ? this.maxBackoffMs : delay;
  }

  private async process(doc: StoredFiscalDocRecord): Promise<Outcome> {
    if (doc.status === 'sent') return this.resolveSent(doc);
    if (doc.status !== 'pending' && doc.status !== 'failed') return 'waiting';

    // K1 shift order (S4): receipts only after the shift OPEN is confirmed on the driver; the Z
    // (shift close) only after every receipt of that shift is terminal.
    const gate = await this.shiftGate(doc);
    if (gate !== 'go') return gate;

    // S3: a refund is sent only after its sale document is confirmed; it is cancelled when the
    // sale document ends up not fiscal (cancelled / rejected).
    if (doc.dependsOnDocId !== null) {
      const dep = this.opts.store.getDocSync(doc.dependsOnDocId);
      if (dep === null || dep.status === 'cancelled' || dep.status === 'rejected') {
        await this.opts.store.cancel(doc, this.opts.nowMs());
        return 'cancelled';
      }
      if (dep.status !== 'confirmed') {
        await this.noteWaiting(
          doc,
          'FISCAL_WAITING_DEPENDENCY',
          'Asl savdo hujjati hali tasdiqlanmagan',
        );
        return 'waiting';
      }
    }

    // (1) `sent` is durable BEFORE the driver sees the request.
    const sent = await this.opts.store.markSent(
      doc,
      this.opts.nowMs(),
      this.opts.nowMs() + this.statusRecheckMs,
    );
    this.opts.__afterSentCommitted?.(sent);

    let result: FiscalSubmitResult;
    try {
      result = await this.opts.driver.submit({
        kind: sent.docKind,
        idempotencyKey: sent.idempotencyKey,
        docId: sent.id,
        saleId: sent.saleId,
        returnId: sent.returnId,
        shiftId: this.opts.store.shiftIdOfDocSync(sent),
      });
    } catch (err) {
      return this.onDriverError(sent, err);
    }
    return this.applyResult(sent, result);
  }

  private async shiftGate(doc: StoredFiscalDocRecord): Promise<'go' | 'waiting'> {
    if (doc.docKind === 'shift_open') return 'go';
    const store = this.opts.store;
    const shiftId = store.shiftIdOfDocSync(doc);
    if (shiftId === null) return 'go';
    const open = store.shiftOpenDocSync(shiftId);
    if (open !== null && open.status !== 'confirmed') {
      if (open.status === 'rejected' || open.status === 'cancelled') {
        // The sale really happened: never auto-cancel. Park it for manual resolution.
        await store.park(doc, 'Fiskal smena ochilmadi (operator rad etdi); qoʻlda hal qiling');
        return 'waiting';
      }
      await this.noteWaiting(doc, 'FISCAL_WAITING_SHIFT_OPEN', 'Fiskal smena hali ochilmagan');
      return 'waiting';
    }
    if (doc.docKind === 'shift_close') {
      const pending = store.shiftReceiptDocsNotTerminalSync(shiftId);
      if (pending.parked > 0) {
        await store.park(doc, 'Smenada hal qilinmagan cheklar bor; Z-hisobot kutmoqda');
        return 'waiting';
      }
      if (pending.live > 0) {
        await this.noteWaiting(
          doc,
          'FISCAL_WAITING_RECEIPTS',
          'Smenaning cheklari hali fiskallashmagan',
        );
        return 'waiting';
      }
    }
    return 'go';
  }

  private async applyResult(sent: StoredFiscalDocRecord, result: FiscalSubmitResult) {
    if (result.outcome === 'confirmed') {
      await this.opts.store.markConfirmed(sent, this.opts.nowMs(), result.confirmation);
      return 'confirmed' as const;
    }
    await this.opts.store.markRejected(sent, result.code, result.message);
    this.opts.logger?.warn(
      { event: 'fiscal.rejected', docId: sent.id, code: result.code },
      'Fiscal document rejected by the operator',
    );
    return 'rejected' as const;
  }

  private async onDriverError(sent: StoredFiscalDocRecord, err: unknown): Promise<Outcome> {
    const now = this.opts.nowMs();
    const next = now + this.backoff(sent.attempts);
    if (isFiscalDriverError(err) && err.kind === 'definitelyNotSent') {
      await this.opts.store.markFailed(sent, err.code, err.message, next);
      return 'failed';
    }
    // Unknown outcome (timeout, 5xx, lost reply, unexpected error): the operator MAY hold the
    // receipt. Stay `sent`; only `status()` may follow.
    const code = isFiscalDriverError(err) ? err.code : 'FISCAL_DRIVER_UNEXPECTED';
    const message = err instanceof Error ? err.message : 'Unexpected fiscal driver failure';
    await this.opts.store.reschedule(sent, next, code, message);
    return 'unknown';
  }

  private async resolveSent(doc: StoredFiscalDocRecord): Promise<Outcome> {
    const now = this.opts.nowMs();
    try {
      const st = await this.opts.driver.status(doc.idempotencyKey);
      if (st.state === 'confirmed') {
        await this.opts.store.markConfirmed(doc, now, st.confirmation);
        return 'confirmed';
      }
      if (st.state === 'rejected') {
        await this.opts.store.markRejected(doc, st.code, st.message);
        return 'rejected';
      }
      // notFound is final for the key → definitely not fiscalized → safe to submit again.
      await this.opts.store.markFailed(
        doc,
        'FISCAL_NOT_FOUND',
        'Operator hujjatni topmadi; qayta yuboriladi',
        now,
      );
      return 'failed';
    } catch (err) {
      const code = isFiscalDriverError(err) ? err.code : 'FISCAL_DRIVER_UNEXPECTED';
      const message = err instanceof Error ? err.message : 'Fiscal status check failed';
      await this.opts.store.reschedule(doc, now + this.backoff(doc.attempts), code, message);
      return 'unknown';
    }
  }
}
