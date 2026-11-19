import {
  type CloudParkedEventDto,
  CloudParkedListResponseSchema,
  CloudResolveParkedResponseSchema,
} from '@mezon/contracts';
import type { LocalSqliteConnection, SqliteCloudStore } from '@mezon/db-local';
import { DomainError, type UnixMs, type UuidV7 } from '@mezon/domain';
import type { SafeStoragePort } from './safe-storage-port.js';

export interface HubCloudParkedServiceOptions {
  readonly connection: LocalSqliteConnection;
  readonly cloudStore: SqliteCloudStore;
  readonly safeStorage: SafeStoragePort;
  readonly nowMs: () => UnixMs;
  readonly fetchFn?: typeof fetch;
}

/**
 * T2.6: the cloud's parked push events of THIS hub, proxied for the POS manager screen. The hub calls
 * the cloud with its own device token, so it only ever sees and resolves its own store's rows.
 * `retry` also re-queues the local outbox event when the hub had already given up on it (rejected),
 * so the next push really goes out with the same event id.
 */
export class HubCloudParkedService {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly o: HubCloudParkedServiceOptions) {
    this.fetchFn = o.fetchFn ?? globalThis.fetch;
  }

  private async session(): Promise<{ url: string; token: string }> {
    const state = await this.o.cloudStore.getCloudState();
    if (!state || state.status !== 'paired' || !state.encryptedDeviceToken || !state.cloudUrl) {
      throw new DomainError('CLOUD_NOT_PAIRED', 'Hub is not paired with the cloud');
    }
    const token = await this.o.safeStorage.decryptString(
      Buffer.from(state.encryptedDeviceToken, 'base64'),
    );
    return { url: state.cloudUrl, token };
  }

  private async call(path: string, init: { method: 'GET' | 'POST'; body?: unknown }) {
    const { url, token } = await this.session();
    let res: Response;
    try {
      res = await this.fetchFn(`${url}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch {
      throw new DomainError('NETWORK_ERROR', 'Bulut serverga ulanib boʻlmadi');
    }
    const json: unknown = await res.json().catch(() => ({}));
    if (res.status === 404) {
      throw new DomainError('SYNC_CONFLICT_NOT_FOUND', 'Parked event not found');
    }
    if (res.status === 409) {
      throw new DomainError('SYNC_CONFLICT_ALREADY_RESOLVED', 'Parked event already resolved');
    }
    if (!res.ok) {
      throw new DomainError('NETWORK_ERROR', `Cloud answered HTTP ${String(res.status)}`);
    }
    return json;
  }

  async list(): Promise<readonly CloudParkedEventDto[]> {
    return CloudParkedListResponseSchema.parse(
      await this.call('/api/v1/sync/parked', { method: 'GET' }),
    ).parked;
  }

  async resolve(params: {
    readonly id: UuidV7;
    readonly action: 'retry' | 'acknowledge';
    readonly note: string | null;
    readonly userId: UuidV7;
  }): Promise<CloudParkedEventDto> {
    const parked = CloudResolveParkedResponseSchema.parse(
      await this.call(`/api/v1/sync/parked/${encodeURIComponent(params.id)}/resolve`, {
        method: 'POST',
        body: {
          action: params.action,
          userId: params.userId,
          ...(params.note !== null ? { note: params.note } : {}),
        },
      }),
    ).parked;
    if (params.action === 'retry') {
      this.o.connection.sqlite
        .prepare(
          `UPDATE local_outbox SET status = 'pending', last_error = NULL, updated_at_ms = ?
            WHERE id = ? AND status = 'rejected'`,
        )
        .run(this.o.nowMs(), parked.eventId);
    }
    return parked;
  }
}
