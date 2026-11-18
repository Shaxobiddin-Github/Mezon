import { createPublicKey, verify } from 'node:crypto';
import type { CloudLicenceStore, GrowthGuard, GrowthUsage } from '@mezon/db-cloud';
import type { UnixMs, UuidV7 } from '@mezon/domain';
import {
  type LicencePayload,
  type LicenceSignatureVerifier,
  type LicenceStatus,
  type LimitKind,
  type TrustedLicenceKey,
  checkPlanLimit,
  resolveLicenceStatus,
  verifyLicence,
} from '@mezon/licensing';

/** Ed25519 over raw 32-byte public keys (same scheme as the rules package, T3.2). */
export const nodeEd25519LicenceVerifier: LicenceSignatureVerifier = {
  verifyEd25519(publicKeyB64: string, message: string, signatureB64: string): boolean {
    const raw = Buffer.from(publicKeyB64, 'base64');
    if (raw.length !== 32) return false;
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  },
};

export class PlanLimitError extends Error {
  constructor(
    readonly kind: LimitKind,
    readonly limit: number,
    readonly state: LicenceStatus['state'],
  ) {
    super(`Plan limit reached for ${kind} (${String(limit)}) in state ${state}`);
    this.name = 'PlanLimitError';
  }
}

/**
 * T4.7: licence status of an organization. Every stored envelope is re-verified on read; an
 * envelope that fails is ignored (and flagged), never trusted because of its index columns.
 */
export class CloudLicenceService {
  constructor(
    private readonly store: CloudLicenceStore,
    private readonly trustedKeys: readonly TrustedLicenceKey[],
    private readonly verifier: LicenceSignatureVerifier = nodeEd25519LicenceVerifier,
  ) {}

  async getStatus(organizationId: UuidV7, nowMs: UnixMs): Promise<LicenceStatus> {
    const [stored, createdAt] = await Promise.all([
      this.store.listLicences(organizationId),
      this.store.getOrganizationCreatedAtMs(organizationId),
    ]);
    const licences: LicencePayload[] = [];
    let invalid = false;
    for (const s of stored) {
      try {
        licences.push(
          verifyLicence(s.envelope, organizationId, this.trustedKeys, this.verifier).payload,
        );
      } catch {
        invalid = true;
      }
    }
    return resolveLicenceStatus({
      licences,
      invalidLicence: invalid,
      organizationCreatedAtMs: createdAt,
      nowMs: BigInt(nowMs),
    });
  }

  async getUsage(organizationId: UuidV7): Promise<GrowthUsage> {
    return this.store.getUsage(organizationId);
  }

  /** Throws `PlanLimitError` when one more store/device would exceed the plan (or growth is frozen). */
  /**
   * The authoritative check (ishchi2 review B2): returns a guard that the store runs INSIDE the
   * transaction that inserts the store / device. It takes the organization's growth lock first, so
   * two parallel requests are serialized and the second one counts the first one's row.
   */
  growthGuard(organizationId: UuidV7, kind: LimitKind, nowMs: UnixMs): GrowthGuard {
    return async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `mezon.growth:${organizationId}`,
      ]);
      const status = await this.getStatus(organizationId, nowMs);
      const res = await client.query<{ n: string }>(
        kind === 'stores'
          ? `SELECT count(*) AS n FROM cloud_stores WHERE organization_id = $1 AND is_active = true`
          : `SELECT count(*) AS n FROM cloud_devices WHERE organization_id = $1 AND status = 'active'`,
        [organizationId],
      );
      const result = checkPlanLimit(status, kind, Number(res.rows[0]?.n ?? 0));
      if (!result.ok) throw new PlanLimitError(kind, result.limit, result.state);
    };
  }

  /** Early, friendly check (e.g. before issuing a pairing code); not a guarantee under races. */
  async assertCanAdd(organizationId: UuidV7, kind: LimitKind, nowMs: UnixMs): Promise<void> {
    const [status, usage] = await Promise.all([
      this.getStatus(organizationId, nowMs),
      this.store.getUsage(organizationId),
    ]);
    const result = checkPlanLimit(status, kind, kind === 'stores' ? usage.stores : usage.devices);
    if (!result.ok) throw new PlanLimitError(kind, result.limit, result.state);
  }
}
