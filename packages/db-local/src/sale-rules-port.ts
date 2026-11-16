import type { UnixMs } from '@mezon/domain';

/**
 * T3.2 rules port (nazoratchi S11): `db-local` does not know the rules engine. The hub injects ONE
 * evaluator (built on `@mezon/rules` `evaluate`) and `completeSaleCoreInTxSync` calls it for every
 * sale path (cart complete, order deliver). The evaluator is a REQUIRED store dependency so a new
 * sale path cannot compile without it.
 */
export interface SaleRulesCheckLine {
  readonly lineId: string;
  readonly lineKind: 'catalog' | 'quick_sale';
  readonly mxik: string | null;
  readonly qtyMilli: bigint;
  readonly finalTotalTiyin: bigint;
  /** FIFO legs actually allocated in this transaction, with their batch expiry. */
  readonly batchExpiries: ReadonlyArray<{
    readonly expiryDateMs: bigint | null;
    readonly qtyMilli: bigint;
  }>;
}

export interface SaleRulesCheckPayment {
  readonly method: string;
  readonly amountTiyin: bigint;
}

export interface SaleRulesCheckInput {
  readonly nowMs: UnixMs;
  readonly lines: readonly SaleRulesCheckLine[];
  readonly payments: readonly SaleRulesCheckPayment[];
}

export interface SaleRulesFinding {
  readonly code: string;
  readonly i18nKey: string;
  readonly lineIds: readonly string[];
  readonly details?: Readonly<Record<string, string>>;
}

export interface SaleRulesCheckResult {
  readonly block: readonly SaleRulesFinding[];
  readonly warn: readonly SaleRulesFinding[];
  readonly packageVersion: string | null;
}

export type SaleRulesEvaluator = (input: SaleRulesCheckInput) => SaleRulesCheckResult;
