/**
 * T3.2 rules engine types. Pure data: no IO, no clock, no crypto (`GEMINI.md` §2.2).
 * Money is bigint tiyin, quantity bigint milli-units (§3.1.1); JSON transport uses strings.
 *
 * Scope per owner answers (TOPSHIRIQ 79df8b8): no prescription rule (S5), no social-card rule
 * (S6 deferred), expired goods only WARN (S7), cash refund of cashless receipts allowed (S8).
 */

/** Stable finding codes; UI translates `rules.<code>` via i18n. */
export const RULE_CODES = [
  'EXPIRED_GOODS',
  'MXIK_MISSING',
  'PACKAGE_MISSING',
  'PACKAGE_EXPIRED',
  'PACKAGE_INVALID',
  'CASH_FORBIDDEN_MXIK',
  'MIXED_RECEIPT_CASHLESS',
  'MXIK_CASH_LIMIT',
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

/**
 * Per-MXIK cash limit (S4). The real value (e.g. 176 mln so'm) exists ONLY in the signed package.
 * - `appliesTo: 'cash'`      — the cash portion attributed to that MXIK (proportional allocation);
 * - `appliesTo: 'mxikTotal'` — the receipt total of that MXIK, applied only when cash is used;
 * - `inclusive: true`        — an amount equal to the limit is allowed (violation only above it).
 */
export interface PerMxikCashLimit {
  readonly limitTiyin: bigint;
  readonly appliesTo: 'cash' | 'mxikTotal';
  readonly inclusive: boolean;
  readonly exempt: MxikMatchList;
}

/** Signed payload. Real rule data comes ONLY from a signed package, never from code. */
export interface RulesPayload {
  readonly packageVersion: bigint;
  readonly issuedAtMs: bigint;
  readonly validUntilMs: bigint;
  readonly sourceRefs: readonly string[];
  readonly cashForbidden: MxikMatchList;
  readonly perMxikCashLimit: PerMxikCashLimit | null;
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
