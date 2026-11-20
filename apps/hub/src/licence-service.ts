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
    try {
      // Everything inside the try: a token that cannot be decrypted (or any other failure) must
      // never become an unhandled rejection of the background refresh.
      const status = await this.opts.cloud.getStatus();
      if (status.status !== 'paired' || !status.cloudUrl || !status.organizationId) return false;
      const token = await this.opts.cloud.getDecryptedToken();
      if (!token) return false;
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

  /**
   * Verifies the cached envelopes against the organization this hub is PAIRED with (never the
   * organization written in the cache file): a cache copied from another organization, or edited to
   * name one, applies nothing.
   */
  /** The verified licence status from the cache, or why it is unknown. Re-verified on every read. */
  private async resolveStatus(): Promise<
    | { readonly known: true; readonly status: LicenceStatus; readonly fetchedAtMs: string | null }
    | { readonly known: false; readonly invalidLicence: boolean }
  > {
    const status = await this.opts.cloud.getStatus();
    const organizationId = status.organizationId;
    if (!organizationId) return { known: false, invalidLicence: false };
    let cache: HubLicenceCache;
    try {
      cache = JSON.parse(fs.readFileSync(this.opts.cachePath, 'utf8')) as HubLicenceCache;
    } catch {
      return { known: false, invalidLicence: false };
    }
    let invalid = cache.organizationId !== organizationId;
    const payloads = [];
    for (const env of Array.isArray(cache.envelopes) ? cache.envelopes : []) {
      try {
        payloads.push(
          verifyLicence(env, organizationId, this.opts.trustedKeys, this.opts.verifier).payload,
        );
      } catch {
        invalid = true;
      }
    }
    let createdAt: bigint;
    try {
      createdAt = BigInt(cache.organizationCreatedAtMs);
    } catch {
      return { known: false, invalidLicence: true };
    }
    return {
      known: true,
      status: resolveLicenceStatus({
        licences: payloads,
        invalidLicence: invalid,
        organizationCreatedAtMs: createdAt,
        nowMs: this.opts.nowMs(),
      }),
      fetchedAtMs: cache.fetchedAtMs ?? null,
    };
  }

  async getView(): Promise<HubLicenceView> {
    const r = await this.resolveStatus();
    if (!r.known) {
      return {
        state: 'unknown',
        plan: null,
        daysLeft: null,
        invalidLicence: r.invalidLicence,
        fetchedAtMs: null,
      };
    }
    return {
      state: r.status.state,
      plan: r.status.plan,
      daysLeft: r.status.daysLeft,
      invalidLicence: r.status.invalidLicence,
      fetchedAtMs: r.fetchedAtMs,
    };
  }

  /**
   * T4.1 × T4.7: how many active LAN terminals the plan allows. The hub itself is one device of the
   * plan, so terminals = `maxDevices - 1`. When expired, growth is frozen (`maxDevices = 0` → 0 new).
   * Unknown licence (never paired / never fetched): no limit here — the hub cannot know the plan,
   * and licensing never stops a shop (GEMINI.md §2); the cloud still enforces its own device limit.
   */
  async lanTerminalLimit(): Promise<{
    readonly maxTerminals: number | null;
    readonly state: string;
  }> {
    const r = await this.resolveStatus();
    if (!r.known) return { maxTerminals: null, state: 'unknown' };
    const max = r.status.limits.maxDevices;
    return { maxTerminals: max === null ? null : Math.max(0, max - 1), state: r.status.state };
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
