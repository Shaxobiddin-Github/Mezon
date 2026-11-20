import type { TrustedLicenceKey } from './licence.js';

/**
 * Production public keys that may sign licences (T4.7). Intentionally EMPTY until the owner
 * generates the licence signing key outside the repository (`scripts/licence-sign.mjs keygen`)
 * and hands over the public key. With an empty list every organization runs on its trial, then
 * in the `expired` state: sales continue, growth (new stores/devices) is blocked.
 * Private keys are NEVER committed.
 */
export const PRODUCTION_TRUSTED_LICENCE_KEYS: readonly TrustedLicenceKey[] = [];
