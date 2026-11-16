/**
 * T3.2 rules engine types. Pure data: no IO, no clock, no crypto (`GEMINI.md` §2.2).
 * Money is bigint tiyin, quantity bigint milli-units (§3.1.1); JSON transport uses strings.
 */

/** Stable finding codes; UI translates `rules.<code>` via i18n. */
export const RULE_CODES = [
  // T3.2a (implemented)
  'EXPIRED_GOODS',
  'SOCIAL_CARD_DATA_REQUIRED',
  'MXIK_MISSING',
  'PACKAGE_MISSING',
  'PACKAGE_EXPIRED',
  'PACKAGE_INVALID',
  // T3.2b (format reserved; semantics pending owner answers S1, S3–S5, S7, S8)
  'CASH_FORBIDDEN_MXIK',
  'MIXED_RECEIPT_CASHLESS',
  'MXIK_CASH_LIMIT',
  'PRESCRIPTION_REQUIRED',
] as const;
export type RuleCode = (typeof RULE_CODES)[number];

export interface RuleFinding {
  readonly code: RuleCode;
  readonly i18nKey: `rules.${RuleCode}`;
  readonly lineIds: readonly string[];
  readonly details?: Readonly<Record<string, string>>;
}

export interface RulesResult {
  readonly block: readonly RuleFinding[];
  readonly warn: readonly RuleFinding[];
  readonly packageVersion: string | null;
}

export interface MxikMatchList {
  readonly exact: readonly string[];
  readonly prefixes: readonly string[];
}

/** Signed payload. Real rule data comes ONLY from a signed package, never from code. */
export interface RulesPayload {
  readonly packageVersion: bigint;
  readonly issuedAtMs: bigint;
  readonly validUntilMs: bigint;
  readonly sourceRefs: readonly string[];
  readonly cashForbidden: MxikMatchList;
  readonly prescriptionRequired: MxikMatchList;
  readonly perMxikCashLimit: {
    readonly limitTiyin: bigint;
    readonly exempt: MxikMatchList;
  } | null;
  readonly socialCard: { readonly enabled: boolean };
  readonly expiredGoods: { readonly enabled: boolean };
}

export const RULES_PACKAGE_FORMAT = 'mezon-rules' as const;
export const RULES_PACKAGE_FORMAT_VERSION = 1 as const;

export interface RulesPackageEnvelope {
  readonly format: typeof RULES_PACKAGE_FORMAT;
  readonly formatVersion: typeof RULES_PACKAGE_FORMAT_VERSION;
  readonly keyId: string;
  readonly payload: RulesPayload;
  /** Base64 Ed25519 signature (64 bytes) over {@link buildRulesSigningMessage}. */
  readonly signature: string;
}

/** An envelope whose signature was verified against a trusted key. */
export interface VerifiedRulesPackage {
  readonly envelope: RulesPackageEnvelope;
  readonly payload: RulesPayload;
  readonly keyId: string;
}

export type RulesPackageState = 'ok' | 'missing' | 'expired' | 'invalid';

export interface SocialCardInput {
  readonly cardType: string;
  readonly cardNumber: string;
  readonly transactionId: string;
}

export interface RulesBatchExpiry {
  /** Batch expiry instant (store-local date semantics), null when the batch has none. */
  readonly expiryDateMs: bigint | null;
  readonly qtyMilli: bigint;
}

export interface RulesCartLineInput {
  readonly lineId: string;
  readonly lineKind: 'catalog' | 'quick_sale';
  readonly mxik: string | null;
  readonly qtyMilli: bigint;
  readonly finalTotalTiyin: bigint;
  /** FIFO legs actually allocated (final phase on the hub). Empty in preview. */
  readonly batchExpiries: readonly RulesBatchExpiry[];
}

export interface RulesCartInput {
  readonly lines: readonly RulesCartLineInput[];
}

export interface RulesPaymentInput {
  readonly method: string;
  readonly amountTiyin: bigint;
  readonly socialCard: SocialCardInput | null;
}

export interface RulesContext {
  readonly nowMs: bigint;
  /** Store-local business date of `nowMs` (`YYYY-MM-DD`), computed by the caller's calendar. */
  readonly todayDateKey: string;
  /** Converts an expiry instant to the store-local `YYYY-MM-DD` date. */
  readonly toDateKey: (unixMs: bigint) => string;
  readonly pkg: VerifiedRulesPackage | null;
  readonly pkgState: RulesPackageState;
  readonly fiscalMode: boolean;
  readonly phase: 'preview' | 'final';
}
