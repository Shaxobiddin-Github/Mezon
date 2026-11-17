import type { TrustedRuleKey } from './verify.js';

/**
 * Production trusted Ed25519 public keys for signed rules packages (T3.2 §2).
 *
 * Intentionally EMPTY until the owner provides the production public key and keyId (question S2).
 * With an empty list no package can be imported in production, so the hub runs in the documented
 * `missing` state (warn now; block once fiscal mode is enabled in T3.3).
 * Private keys are NEVER committed to this repository.
 */
export const PRODUCTION_TRUSTED_RULE_KEYS: readonly TrustedRuleKey[] = [];
