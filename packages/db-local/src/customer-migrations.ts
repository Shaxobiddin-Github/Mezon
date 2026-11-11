import {
  type EntityFtsSearchConfig,
  assertEntityFtsMigrationsComplete,
  buildEntityFtsSearchSql,
} from './catalog-search-schema.js';

const CUSTOMER_FTS_CONFIG: EntityFtsSearchConfig = {
  baseTableName: 'customers',
  ftsTableName: 'customers_fts',
  entityIdColumn: 'customer_id',
  primarySearchColumn: 'name_search',
  secondarySearchColumn: 'phone_digits',
  baseSecondarySourceColumn: 'phone_digits',
  insertTriggerName: 'trg_customers_fts_after_insert',
  updateTriggerName: 'trg_customers_fts_after_update',
};

export function buildCustomerSearchFtsSql(): string[] {
  return buildEntityFtsSearchSql(CUSTOMER_FTS_CONFIG);
}

/**
 * Verifies T1.7 customer directory & ledger migrations preserve:
 * - `customers_fts` FTS5 table without `content=`/`rowid` coupling & active UUID-keyed triggers
 * - `uidx_customer_ledger_opening_balance` partial unique index enforcing single opening balance per customer
 */
export function assertCustomerMigrationsComplete(migrationsDir: string): void {
  const sqlContent = assertEntityFtsMigrationsComplete(migrationsDir, CUSTOMER_FTS_CONFIG);

  const openingIdxMatch =
    /CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"uidx_customer_ledger_opening_balance"|`uidx_customer_ledger_opening_balance`|uidx_customer_ledger_opening_balance)\s+ON\s+(?:"customer_ledger"|`customer_ledger`|customer_ledger)[\s\S]*?WHERE[\s\S]*?opening_balance/i.exec(
      sqlContent,
    );
  if (!openingIdxMatch) {
    throw new Error(
      'Missing active partial unique index "uidx_customer_ledger_opening_balance" for opening_balance uniqueness',
    );
  }
}
