import { ZERO_MONEY, moneyToTiyin } from '@mezon/domain';

export const RULES_PACKAGE = '@mezon/rules';

export function isDomainAvailable(): boolean {
  return moneyToTiyin(ZERO_MONEY) === 0n;
}

export * from './types.js';
export { canonicalJson } from './canonical.js';
export {
  RULES_SIGNING_PREFIX,
  parseRulesPayload,
  parseRulesEnvelope,
  rulesPayloadToWire,
  buildRulesSigningMessage,
  rulesEnvelopeToCanonicalJson,
} from './package.js';
export {
  type TrustedRuleKey,
  type RulesSignatureVerifier,
  verifyRulesPackage,
  resolveRulesPackageState,
} from './verify.js';
export { matchesMxikList, evaluate } from './evaluate.js';
export { PRODUCTION_TRUSTED_RULE_KEYS } from './trusted-keys.js';
