import { DomainError } from '@mezon/domain';
import { buildRulesSigningMessage, parseRulesEnvelope } from './package.js';
import type { RulesPackageState, VerifiedRulesPackage } from './types.js';

export interface TrustedRuleKey {
  readonly keyId: string;
  /** Raw 32-byte Ed25519 public key, base64. */
  readonly publicKeyB64: string;
  readonly validFromMs: bigint;
  readonly validUntilMs: bigint | null;
}

/**
 * Signature port (T3.2 §2): `packages/rules` imports only `@mezon/domain`, so Ed25519 lives in the
 * hub (`node:crypto`). The implementation UTF-8 encodes `message` itself.
 */
export interface RulesSignatureVerifier {
  verifyEd25519(publicKeyB64: string, message: string, signatureB64: string): boolean;
}

/**
 * Parses and verifies a wire envelope against the trusted key list.
 * Throws `RULES_PACKAGE_INVALID` | `RULES_KEY_UNTRUSTED` | `RULES_SIGNATURE_INVALID`.
 * The key must have been valid when the package was issued (rotation window).
 */
export function verifyRulesPackage(
  raw: unknown,
  trustedKeys: readonly TrustedRuleKey[],
  verifier: RulesSignatureVerifier,
): VerifiedRulesPackage {
  const envelope = parseRulesEnvelope(raw);
  const key = trustedKeys.find((k) => k.keyId === envelope.keyId);
  if (key === undefined) {
    throw new DomainError('RULES_KEY_UNTRUSTED', `Unknown rules key "${envelope.keyId}"`);
  }
  const issued = envelope.payload.issuedAtMs;
  if (issued < key.validFromMs || (key.validUntilMs !== null && issued > key.validUntilMs)) {
    throw new DomainError(
      'RULES_KEY_UNTRUSTED',
      `Rules key "${envelope.keyId}" was not valid at package issue time`,
    );
  }
  const message = buildRulesSigningMessage(envelope.keyId, envelope.payload);
  let ok = false;
  try {
    ok = verifier.verifyEd25519(key.publicKeyB64, message, envelope.signature);
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new DomainError('RULES_SIGNATURE_INVALID', 'Rules package signature is invalid');
  }
  return { envelope, payload: envelope.payload, keyId: envelope.keyId };
}

/** Package state at `nowMs` (T3.2 §8). `invalid` is decided by the loader (failed re-verification). */
export function resolveRulesPackageState(
  pkg: VerifiedRulesPackage | null,
  loadFailed: boolean,
  nowMs: bigint,
): RulesPackageState {
  if (loadFailed) return 'invalid';
  if (pkg === null) return 'missing';
  return nowMs > pkg.payload.validUntilMs ? 'expired' : 'ok';
}
