import fs from 'node:fs';
import {
  type LicenceSignatureVerifier,
  type LicenceStatus,
  type TrustedLicenceKey,
  resolveLicenceStatus,
  verifyLicence,
} from '@mezon/licensing';
import type { HubCloudService } from './cloud-service.js';

export interface HubLicenceCache {
  readonly organizationId: string;
  readonly organizationCreatedAtMs: string;
  readonly envelopes: readonly unknown[];
  readonly fetchedAtMs: string;
}

export interface HubLicenceView {
  /** `unknown`: never fetched (unpaired hub or no cloud yet). Sales are never affected. */
  readonly state: LicenceStatus['state'] | 'unknown';
  readonly plan: LicenceStatus['plan'];
  readonly daysLeft: number | null;
  readonly invalidLicence: boolean;
  readonly fetchedAtMs: string | null;
}

export interface HubLicenceServiceOptions {
  readonly cloud: Pick<HubCloudService, 'getStatus' | 'getDecryptedToken'>;
  readonly cachePath: string;
  readonly trustedKeys: readonly TrustedLicenceKey[];
  readonly verifier: LicenceSignatureVerifier;
  readonly nowMs: () => bigint;
  readonly fetchFn?: typeof fetch;
  readonly logger?: { warn(obj: object, msg: string): void };
}

/**
 * T4.7 on the hub: the signed licence envelopes are fetched from the cloud when online, kept in a
 * file next to the database, and re-verified on every read, so the hub knows its plan offline and a
 * hand-edited cache gains nothing. Purely informative here (banner); limits are enforced where
 * growth happens (cloud: stores, devices; LAN terminals in T4.1).
 */
export class HubLicenceService {
  private readonly fetchFn: typeof fetch;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: HubLicenceServiceOptions) {
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  /** Fetches the envelopes; keeps the old cache on any failure. Returns true when refreshed. */
  async refresh(): Promise<boolean> {
    const status = await this.opts.cloud.getStatus();
    if (status.status !== 'paired' || !status.cloudUrl || !status.organizationId) return false;
    const token = await this.opts.cloud.getDecryptedToken();
    if (!token) return false;
    try {
      const res = await this.fetchFn(`${status.cloudUrl}/api/v1/devices/licence`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as {
        organizationCreatedAtMs?: unknown;
        envelopes?: unknown;
      };
      if (typeof body.organizationCreatedAtMs !== 'string' || !Array.isArray(body.envelopes)) {
        return false;
      }
      const cache: HubLicenceCache = {
        organizationId: status.organizationId,
        organizationCreatedAtMs: body.organizationCreatedAtMs,
        envelopes: body.envelopes as unknown[],
        fetchedAtMs: this.opts.nowMs().toString(),
      };
      const tmp = `${this.opts.cachePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cache));
      fs.renameSync(tmp, this.opts.cachePath);
      return true;
    } catch (err) {
      this.opts.logger?.warn(
        { event: 'licence.refresh_failed', kind: err instanceof Error ? err.name : 'unknown' },
        'Licence refresh failed',
      );
      return false;
    }
  }

  getView(): HubLicenceView {
    let cache: HubLicenceCache;
    try {
      cache = JSON.parse(fs.readFileSync(this.opts.cachePath, 'utf8')) as HubLicenceCache;
    } catch {
      return {
        state: 'unknown',
        plan: null,
        daysLeft: null,
        invalidLicence: false,
        fetchedAtMs: null,
      };
    }
    let invalid = false;
    const payloads = [];
    for (const env of Array.isArray(cache.envelopes) ? cache.envelopes : []) {
      try {
        payloads.push(
          verifyLicence(env, cache.organizationId, this.opts.trustedKeys, this.opts.verifier)
            .payload,
        );
      } catch {
        invalid = true;
      }
    }
    let createdAt: bigint;
    try {
      createdAt = BigInt(cache.organizationCreatedAtMs);
    } catch {
      return {
        state: 'unknown',
        plan: null,
        daysLeft: null,
        invalidLicence: true,
        fetchedAtMs: null,
      };
    }
    const s = resolveLicenceStatus({
      licences: payloads,
      invalidLicence: invalid,
      organizationCreatedAtMs: createdAt,
      nowMs: this.opts.nowMs(),
    });
    return {
      state: s.state,
      plan: s.plan,
      daysLeft: s.daysLeft,
      invalidLicence: s.invalidLicence,
      fetchedAtMs: cache.fetchedAtMs ?? null,
    };
  }

  start(intervalMs = 6 * 60 * 60 * 1000): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
