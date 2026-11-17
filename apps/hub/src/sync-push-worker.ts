import {
  type SyncEventEnvelopeDto,
  type SyncPushRequestDto,
  type SyncPushResponseDto,
  sliceOutboxBatch,
} from '@mezon/sync';
import type { SqliteCloudStore, SqliteOutboxSyncStore } from '@mezon/db-local';
import {
  type Clock,
  type IdGenerator,
  type PersistedOutboxRecord,
  type UnixMs,
  type UuidV7,
  parseUuidV7,
} from '@mezon/domain';
import type { SafeStoragePort } from './safe-storage-port.js';

export interface HubSyncPushWorkerOptions {
  readonly outboxStore: SqliteOutboxSyncStore;
  readonly cloudStore: SqliteCloudStore;
  readonly safeStorage: SafeStoragePort;
  readonly getDeviceId: () => Promise<UuidV7> | UuidV7;
  readonly clock: Clock;
  readonly idGen: IdGenerator;
  readonly fetchFn?: typeof fetch;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly pullWorker?: { pullBatch(): Promise<unknown> };
}

export interface PushBatchResult {
  readonly pushed: number;
  readonly acked: number;
  readonly rejected: number;
  readonly retried: number;
  readonly status: 'ok' | 'idle' | 'stopped' | 'backoff' | 'upgrade_required';
  readonly error?: string;
}

export class HubSyncPushWorker {
  private readonly outboxStore: SqliteOutboxSyncStore;
  private readonly cloudStore: SqliteCloudStore;
  private readonly safeStorage: SafeStoragePort;
  private readonly getDeviceId: () => Promise<UuidV7> | UuidV7;
  private readonly clock: Clock;
  private readonly idGen: IdGenerator;
  private readonly fetchFn: typeof fetch;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly pullWorker?: { pullBatch(): Promise<unknown> };

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;
  private currentBackoffMs = 0;

  constructor(options: HubSyncPushWorkerOptions) {
    this.outboxStore = options.outboxStore;
    this.cloudStore = options.cloudStore;
    this.safeStorage = options.safeStorage;
    this.getDeviceId = options.getDeviceId;
    this.clock = options.clock;
    this.idGen = options.idGen;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.minBackoffMs = options.minBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60000;
    this.pullWorker = options.pullWorker;
  }

  isRunning(): boolean {
    return this.running;
  }

  getCurrentBackoffMs(): number {
    return this.currentBackoffMs;
  }

  start(intervalMs: number = 3000): void {
    if (this.running) {
      return;
    }
    this.running = true;

    const scheduleNext = () => {
      if (!this.running) {
        return;
      }
      const delay = this.currentBackoffMs > 0 ? this.currentBackoffMs : intervalMs;
      this.timer = setTimeout(() => {
        void (async () => {
          try {
            await this.pushBatch();
          } catch {
            // Handled inside pushBatch
          } finally {
            scheduleNext();
          }
        })();
      }, delay);
    };

    scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async pushBatch(): Promise<PushBatchResult> {
    if (this.inFlight) {
      return { pushed: 0, acked: 0, rejected: 0, retried: 0, status: 'idle' };
    }
    this.inFlight = true;

    try {
      return await this.executePushBatch();
    } finally {
      this.inFlight = false;
    }
  }

  private async executePushBatch(): Promise<PushBatchResult> {
    const cloudState = await this.cloudStore.getCloudState();
    if (!cloudState || cloudState.status !== 'paired' || !cloudState.encryptedDeviceToken) {
      return { pushed: 0, acked: 0, rejected: 0, retried: 0, status: 'idle' };
    }

    const deviceId = await this.getDeviceId();
    const nowMs = this.clock.now();

    // Query pending events in strict deviceSeq ASC order
    const pendingRows = this.outboxStore.getPendingBatch(100);
    if (pendingRows.length === 0) {
      if (this.pullWorker) {
        try {
          await this.pullWorker.pullBatch();
        } catch {
          // Handled inside pullWorker
        }
      }
      return { pushed: 0, acked: 0, rejected: 0, retried: 0, status: 'idle' };
    }

    // Limit to max 100 events and max 1MB
    const batchRows: readonly PersistedOutboxRecord[] = sliceOutboxBatch(
      pendingRows,
      100,
      1024 * 1024,
    );

    // Decrypt device token
    const tokenBuffer = Buffer.from(cloudState.encryptedDeviceToken, 'base64');
    let deviceToken: string;
    try {
      deviceToken = await this.safeStorage.decryptString(tokenBuffer);
    } catch (err) {
      return {
        pushed: 0,
        acked: 0,
        rejected: 0,
        retried: 0,
        status: 'stopped',
        error: `Failed to decrypt device token: ${(err as Error).message}`,
      };
    }

    const eventsDto: SyncEventEnvelopeDto[] = batchRows.map((r) => ({
      eventId: r.eventId,
      organizationId: r.organizationId,
      storeId: r.storeId ?? null,
      deviceId: r.deviceId,
      deviceSeq: r.deviceSeq.toString(),
      hlc: r.hlc,
      type: r.type,
      entity: r.entity,
      entityId: r.entityId,
      entityClass: r.class,
      schemaVersion: r.schemaVersion,
      payload:
        typeof r.payload === 'string'
          ? (JSON.parse(r.payload) as Record<string, unknown>)
          : r.payload,
    }));

    const pushPayload: SyncPushRequestDto = {
      clientVersion: '1.0.0',
      storeId: cloudState.storeId!,
      deviceId,
      events: eventsDto,
    };

    let response: Response;
    try {
      response = await this.fetchFn(`${cloudState.cloudUrl}/api/v1/sync/push`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deviceToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(pushPayload),
      });
    } catch (netErr) {
      // Network or DNS failure -> backoff
      this.applyBackoff();
      this.incrementAttempts(batchRows, (netErr as Error).message, nowMs);
      return {
        pushed: batchRows.length,
        acked: 0,
        rejected: 0,
        retried: batchRows.length,
        status: 'backoff',
        error: (netErr as Error).message,
      };
    }

    // Handle HTTP Error Codes
    if (!response.ok) {
      let body: { error?: string; code?: string; message?: string } = {};
      try {
        body = (await response.json()) as typeof body;
      } catch {
        // ignore
      }

      // P5: Differentiated 401 / 403 handling
      if (response.status === 401 || response.status === 403) {
        const isRevokedCode =
          body.code === 'DEVICE_REVOKED' ||
          body.code === 'DEVICE_BLOCKED' ||
          body.code === 'DEVICE_TOKEN_REUSE';

        if (isRevokedCode) {
          await this.cloudStore.updateCloudStatus('revoked', nowMs);
          this.stop();
          return {
            pushed: 0,
            acked: 0,
            rejected: 0,
            retried: 0,
            status: 'stopped',
            error: body.message ?? 'Device revoked or blocked by cloud',
          };
        }

        if (body.code === 'TOKEN_EXPIRED') {
          const rotated = await this.rotateDeviceToken(cloudState.cloudUrl!, deviceToken, nowMs);
          if (rotated) {
            return this.executePushBatch();
          }
          this.applyBackoff();
          return {
            pushed: 0,
            acked: 0,
            rejected: 0,
            retried: batchRows.length,
            status: 'backoff',
            error: 'Token expired and rotation failed',
          };
        }
      }

      if (response.status === 426) {
        this.stop();
        return {
          pushed: 0,
          acked: 0,
          rejected: 0,
          retried: 0,
          status: 'upgrade_required',
          error: body.message ?? 'Client version unsupported by cloud',
        };
      }

      // 5xx or other status -> backoff
      this.applyBackoff();
      this.incrementAttempts(batchRows, body.message ?? `HTTP ${response.status}`, nowMs);
      return {
        pushed: batchRows.length,
        acked: 0,
        rejected: 0,
        retried: batchRows.length,
        status: 'backoff',
        error: body.message ?? `Server returned ${response.status}`,
      };
    }

    // Success response (200 OK)
    this.currentBackoffMs = 0; // Reset backoff

    const pushResponse = (await response.json()) as SyncPushResponseDto;
    let ackedCount = 0;
    let rejectedCount = 0;
    let retriedCount = 0;

    const eventMap = new Map(batchRows.map((r) => [r.eventId, r]));

    for (const res of pushResponse.results) {
      const row = eventMap.get(parseUuidV7(res.eventId));
      if (!row) {
        continue;
      }

      if (res.status === 'accepted' || res.status === 'duplicate') {
        this.outboxStore.markAcked(row.eventId, nowMs);
        ackedCount += 1;
      } else if (res.status === 'rejected') {
        // Divert rejected event to local_sync_conflicts so queue never blocks
        const reason = res.reason ?? 'UNKNOWN_REJECTION';
        const error = res.error ?? null;
        this.outboxStore.markRejected(row.eventId, `${reason}: ${error ?? ''}`, nowMs);

        this.outboxStore.recordConflict(
          {
            id: this.idGen.nextId(),
            organizationId: row.organizationId,
            storeId: row.storeId,
            eventId: row.eventId,
            entity: row.entity,
            entityId: row.entityId,
            reason,
            error,
            payload: row.payload,
          },
          nowMs,
        );
        rejectedCount += 1;
      } else if (res.status === 'retry') {
        this.outboxStore.markRetry(row.eventId, res.reason ?? 'Retry requested by cloud', nowMs);
        retriedCount += 1;
      }
    }

    // Update lastSyncAtMs
    await this.cloudStore.updateLastSyncAt(nowMs);

    // T2.4: Trigger paired pullWorker in the same sync cycle (push first, then pull)
    if (this.pullWorker) {
      try {
        await this.pullWorker.pullBatch();
      } catch {
        // Handled inside pullWorker
      }
    }

    return {
      pushed: batchRows.length,
      acked: ackedCount,
      rejected: rejectedCount,
      retried: retriedCount,
      status: 'ok',
    };
  }

  private applyBackoff(): void {
    if (this.currentBackoffMs === 0) {
      this.currentBackoffMs = this.minBackoffMs;
    } else {
      this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.maxBackoffMs);
    }
  }

  private incrementAttempts(
    rows: readonly PersistedOutboxRecord[],
    errorMessage: string,
    nowMs: UnixMs,
  ): void {
    for (const row of rows) {
      this.outboxStore.markRetry(row.eventId, errorMessage, nowMs);
    }
  }

  private async rotateDeviceToken(
    cloudUrl: string,
    currentToken: string,
    nowMs: UnixMs,
  ): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${cloudUrl}/api/v1/devices/rotate-token`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${currentToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientRequestId: this.idGen.nextId(),
        }),
      });

      if (!res.ok) {
        return false;
      }

      const data = (await res.json()) as { deviceToken: string };
      const encryptedBytes = await this.safeStorage.encryptString(data.deviceToken);
      const encryptedDeviceToken = encryptedBytes.toString('base64');

      const currentState = await this.cloudStore.getCloudState();
      if (currentState) {
        await this.cloudStore.saveCloudState({
          status: 'paired',
          cloudUrl: currentState.cloudUrl!,
          organizationId: currentState.organizationId!,
          organizationName: currentState.organizationName!,
          storeId: currentState.storeId!,
          storeName: currentState.storeName!,
          encryptedDeviceToken,
          pairedAtMs: currentState.pairedAtMs ?? nowMs,
          nowMs,
          idGen: this.idGen,
        });
      }
      return true;
    } catch {
      return false;
    }
  }
}
