import {
  type EntityFtsSearchConfig,
  assertEntityFtsMigrationsComplete,
  buildEntityFtsSearchSql,
} from './catalog-search-schema.js';

const SUPPLIER_FTS_CONFIG: EntityFtsSearchConfig = {
  baseTableName: 'suppliers',
  ftsTableName: 'suppliers_fts',
  entityIdColumn: 'supplier_id',
  primarySearchColumn: 'name_search',
  secondarySearchColumn: 'phone_digits',
  baseSecondarySourceColumn: 'phone_digits',
  insertTriggerName: 'trg_suppliers_fts_after_insert',
  updateTriggerName: 'trg_suppliers_fts_after_update',
};

export function buildSupplierSearchFtsSql(): string[] {
  return buildEntityFtsSearchSql(SUPPLIER_FTS_CONFIG);
}

/**
 * Verifies T1.8 supplier directory, receiving cost confirmation, and ledger migrations preserve:
 * - `suppliers_fts` FTS5 table without `content=`/`rowid` coupling & active UUID-keyed triggers
 * - `uidx_supplier_ledger_opening_balance` partial unique index enforcing single opening balance per supplier
 * - `uidx_receiving_cost_confirms_line` unique index enforcing single cost confirmation per receiving line
 */
export function assertSupplierMigrationsComplete(migrationsDir: string): void {
  const sqlContent = assertEntityFtsMigrationsComplete(migrationsDir, SUPPLIER_FTS_CONFIG);

  const openingIdxMatch =
    /CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"uidx_supplier_ledger_opening_balance"|`uidx_supplier_ledger_opening_balance`|uidx_supplier_ledger_opening_balance)\s+ON\s+(?:"supplier_ledger"|`supplier_ledger`|supplier_ledger)[\s\S]*?WHERE[\s\S]*?opening_balance/i.exec(
      sqlContent,
    );
  if (!openingIdxMatch) {
    throw new Error(
      'Missing active partial unique index "uidx_supplier_ledger_opening_balance" for supplier opening_balance uniqueness',
    );
  }

  const confirmLineIdxMatch =
    /CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"uidx_receiving_cost_confirms_line"|`uidx_receiving_cost_confirms_line`|uidx_receiving_cost_confirms_line)\s+ON\s+(?:"receiving_cost_confirmations"|`receiving_cost_confirmations`|receiving_cost_confirmations)/i.exec(
      sqlContent,
    );
  if (!confirmLineIdxMatch) {
    throw new Error(
      'Missing unique index "uidx_receiving_cost_confirms_line" for single cost confirmation per receiving line',
    );
  }
}
