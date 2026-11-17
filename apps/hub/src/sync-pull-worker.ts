import { type SyncPullResponseDto, SyncPullResponseSchema } from '@mezon/sync';
import type { SqliteCloudStore } from '@mezon/db-local';
import { type Clock, type IdGenerator, type UnixMs, type UuidV7 } from '@mezon/domain';
import type { SafeStoragePort } from './safe-storage-port.js';
import type { HubSyncPullService } from './sync-pull-service.js';

export interface HubSyncPullWorkerOptions {
  readonly pullService: HubSyncPullService;
  readonly cloudStore: SqliteCloudStore;
  readonly safeStorage: SafeStoragePort;
  readonly getDeviceId: () => Promise<UuidV7> | UuidV7;
  readonly clock: Clock;
  readonly idGen: IdGenerator;
  readonly fetchFn?: typeof fetch;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Events per pull page (cloud caps it). Default 100. */
  readonly pageSize?: number;
}

export interface PullBatchResult {
  readonly pulled: number;
  readonly applied: number;
  readonly skippedEcho: number;
  readonly parked: number;
  readonly conflicts: number;
  readonly status: 'ok' | 'idle' | 'stopped' | 'backoff' | 'upgrade_required';
  readonly hasMore?: boolean;
  readonly error?: string;
}

export class HubSyncPullWorker {
  private readonly pullService: HubSyncPullService;
  private readonly cloudStore: SqliteCloudStore;
  private readonly safeStorage: SafeStoragePort;
  private readonly getDeviceId: () => Promise<UuidV7> | UuidV7;
  private readonly clock: Clock;
  private readonly idGen: IdGenerator;
  private readonly fetchFn: typeof fetch;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;
  private currentBackoffMs = 0;

  private readonly pageSize: number;

  constructor(options: HubSyncPullWorkerOptions) {
    this.pullService = options.pullService;
    this.cloudStore = options.cloudStore;
    this.safeStorage = options.safeStorage;
    this.getDeviceId = options.getDeviceId;
    this.clock = options.clock;
    this.idGen = options.idGen;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.minBackoffMs = options.minBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60000;
    this.pageSize = options.pageSize ?? 100;
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
            await this.pullBatch();
          } catch {
            // Handled inside pullBatch
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

  async pullBatch(): Promise<PullBatchResult> {
    if (this.inFlight) {
      return { pulled: 0, applied: 0, skippedEcho: 0, parked: 0, conflicts: 0, status: 'idle' };
    }
    this.inFlight = true;

    try {
      return await this.executePullBatch();
    } finally {
      this.inFlight = false;
    }
  }

  private async executePullBatch(): Promise<PullBatchResult> {
    const cloudState = await this.cloudStore.getCloudState();
    if (
      !cloudState ||
      cloudState.status !== 'paired' ||
      !cloudState.encryptedDeviceToken ||
      !cloudState.organizationId ||
      !cloudState.storeId ||
      !cloudState.cloudUrl
    ) {
      return { pulled: 0, applied: 0, skippedEcho: 0, parked: 0, conflicts: 0, status: 'idle' };
    }

    const deviceId = await this.getDeviceId();
    const nowMs = this.clock.now();

    // Decrypt device token
    const tokenBuffer = Buffer.from(cloudState.encryptedDeviceToken, 'base64');
    let deviceToken: string;
    try {
      deviceToken = await this.safeStorage.decryptString(tokenBuffer);
    } catch (err) {
      return {
        pulled: 0,
        applied: 0,
        skippedEcho: 0,
        parked: 0,
        conflicts: 0,
        status: 'stopped',
        error: `Failed to decrypt device token: ${(err as Error).message}`,
      };
    }

    // Prepare cursors query
    const currentCursors = this.pullService.getCursors(cloudState.organizationId);
    const cursorPairs = Object.entries(currentCursors).map(([sId, pos]) => `${sId}:${pos}`);
    const queryParams = new URLSearchParams();
    if (cursorPairs.length > 0) {
      queryParams.set('cursors', cursorPairs.join(','));
    }
    queryParams.set('limit', String(this.pageSize));
    const pullUrl = `${cloudState.cloudUrl}/api/v1/sync/pull?${queryParams.toString()}`;

    let response: Response;
    try {
      response = await this.fetchFn(pullUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${deviceToken}`,
          Accept: 'application/json',
        },
      });
    } catch (netErr) {
      this.applyBackoff();
      return {
        pulled: 0,
        applied: 0,
        skippedEcho: 0,
        parked: 0,
        conflicts: 0,
        status: 'backoff',
        error: (netErr as Error).message,
      };
    }

    if (!response.ok) {
      let body: { error?: string; code?: string; message?: string } = {};
      try {
        body = (await response.json()) as typeof body;
      } catch {
        // ignore
      }

      if (response.status === 401 || response.status === 403) {
        const isRevokedCode =
          body.code === 'DEVICE_REVOKED' ||
          body.code === 'DEVICE_BLOCKED' ||
          body.code === 'DEVICE_TOKEN_REUSE';

        if (isRevokedCode) {
          await this.cloudStore.updateCloudStatus('revoked', nowMs);
          this.stop();
          return {
            pulled: 0,
            applied: 0,
            skippedEcho: 0,
            parked: 0,
            conflicts: 0,
            status: 'stopped',
            error: body.message ?? 'Device revoked or blocked by cloud',
          };
        }

        if (body.code === 'TOKEN_EXPIRED') {
          const rotated = await this.rotateDeviceToken(cloudState.cloudUrl, deviceToken, nowMs);
          if (rotated) {
            return this.executePullBatch();
          }
          this.applyBackoff();
          return {
            pulled: 0,
            applied: 0,
            skippedEcho: 0,
            parked: 0,
            conflicts: 0,
            status: 'backoff',
            error: 'Token expired and rotation failed',
          };
        }
      }

      if (response.status === 426) {
        this.stop();
        return {
          pulled: 0,
          applied: 0,
          skippedEcho: 0,
          parked: 0,
          conflicts: 0,
          status: 'upgrade_required',
          error: body.message ?? 'Client upgrade required by cloud',
        };
      }

      this.applyBackoff();
      return {
        pulled: 0,
        applied: 0,
        skippedEcho: 0,
        parked: 0,
        conflicts: 0,
        status: 'backoff',
        error: `Cloud returned HTTP ${response.status}: ${body.message ?? response.statusText}`,
      };
    }

    const json = (await response.json()) as SyncPullResponseDto;
    const parsed = SyncPullResponseSchema.safeParse(json);
    if (!parsed.success) {
      this.applyBackoff();
      return {
        pulled: 0,
        applied: 0,
        skippedEcho: 0,
        parked: 0,
        conflicts: 0,
        status: 'backoff',
        error: `Invalid pull response schema: ${parsed.error.message}`,
      };
    }

    const { events, nextCursors, hasMore } = parsed.data;

    const parsedNextCursors: Record<string, bigint> = {};
    for (const [sId, pStr] of Object.entries(nextCursors)) {
      parsedNextCursors[sId] = BigInt(pStr);
    }

    const applyResult = this.pullService.applySyncPullBatch({
      context: {
        organizationId: cloudState.organizationId,
        storeId: cloudState.storeId,
        deviceId,
      },
      events,
      nextCursors: parsedNextCursors,
      nowMs,
    });

    this.currentBackoffMs = 0;
    await this.cloudStore.updateLastSyncAt(nowMs);

    return {
      pulled: events.length,
      applied: applyResult.appliedCount,
      skippedEcho: applyResult.skippedEchoCount,
      parked: applyResult.parkedCount,
      conflicts: applyResult.conflictCount,
      status: 'ok',
      hasMore,
    };
  }

  private applyBackoff(): void {
    if (this.currentBackoffMs === 0) {
      this.currentBackoffMs = this.minBackoffMs;
    } else {
      this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.maxBackoffMs);
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
