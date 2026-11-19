import type { LocalSqliteConnection } from '@mezon/db-local';
import type { UnixMs } from '@mezon/domain';
import type { HubSyncPullWorker } from './sync-pull-worker.js';

export type BootstrapState = 'none' | 'in_progress' | 'done';

export interface BootstrapStatus {
  readonly state: BootstrapState;
  readonly pagesApplied: number;
}

export interface BootstrapRunResult extends BootstrapStatus {
  /** Why this run stopped: caught up, or the cloud / network failed (resume later). */
  readonly stoppedBecause: 'caught_up' | 'cloud_unavailable' | 'not_paired' | 'page_limit';
}

/**
 * T2.5 initial load of a hub from the cloud (Variant A: no separate snapshot — the pull IS the
 * load). Every page is applied in ONE SQLite transaction together with the cursors it advances
 * (`HubSyncPullService.applySyncPullBatch`), so an interruption at any point loses nothing and
 * applies nothing twice: the next run continues from the last committed page. The state is kept in
 * `local_sync_apply_state` (`none` → `in_progress` → `done`) for the POS / cabinet to show.
 */
export class HubSyncBootstrap {
  constructor(
    private readonly o: {
      readonly connection: LocalSqliteConnection;
      readonly pullWorker: HubSyncPullWorker;
      readonly nowMs: () => UnixMs;
    },
  ) {}

  status(): BootstrapStatus {
    const row = this.o.connection.sqlite
      .prepare(
        "SELECT bootstrap_state AS s, bootstrap_pages AS p FROM local_sync_apply_state WHERE id = 'singleton'",
      )
      .get() as { s: BootstrapState; p: number | bigint } | undefined;
    return { state: row?.s ?? 'none', pagesApplied: Number(row?.p ?? 0) };
  }

  private set(state: BootstrapState, pagesDelta: number): void {
    this.o.connection.sqlite
      .prepare(
        `UPDATE local_sync_apply_state
            SET bootstrap_state = ?, bootstrap_pages = bootstrap_pages + ?, updated_at_ms = ?
          WHERE id = 'singleton'`,
      )
      .run(state, pagesDelta, this.o.nowMs());
  }

  /** Pulls page after page until the cloud says there is nothing more (or it fails: resumable). */
  async run(maxPages = 100_000): Promise<BootstrapRunResult> {
    for (let page = 0; page < maxPages; page += 1) {
      const res = await this.o.pullWorker.pullBatch();
      if (res.status === 'idle') return { ...this.status(), stoppedBecause: 'not_paired' };
      if (res.status !== 'ok') return { ...this.status(), stoppedBecause: 'cloud_unavailable' };
      this.set('in_progress', 1);
      if (res.hasMore !== true) {
        this.set('done', 0);
        return { ...this.status(), stoppedBecause: 'caught_up' };
      }
    }
    return { ...this.status(), stoppedBecause: 'page_limit' };
  }
}
