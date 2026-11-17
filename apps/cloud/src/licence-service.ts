import { createPublicKey, verify } from 'node:crypto';
import type { CloudLicenceStore, GrowthUsage } from '@mezon/db-cloud';
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
  async assertCanAdd(organizationId: UuidV7, kind: LimitKind, nowMs: UnixMs): Promise<void> {
    const [status, usage] = await Promise.all([
      this.getStatus(organizationId, nowMs),
      this.store.getUsage(organizationId),
    ]);
    const result = checkPlanLimit(status, kind, kind === 'stores' ? usage.stores : usage.devices);
    if (!result.ok) throw new PlanLimitError(kind, result.limit, result.state);
  }
}
