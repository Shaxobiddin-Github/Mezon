/**
 * TEST-ONLY rules evaluator that never blocks (T3.2). Used by storage-layer tests that are not
 * about legal rules; the hub always injects the real `@mezon/rules`-based evaluator.
 * Structurally matches `SaleRulesEvaluator` from `@mezon/db-local` (no import to keep test-utils pure).
 */
export function allowAllSaleRulesEvaluator(): {
  readonly block: readonly never[];
  readonly warn: readonly never[];
  readonly packageVersion: null;
} {
  return { block: [], warn: [], packageVersion: null };
}
