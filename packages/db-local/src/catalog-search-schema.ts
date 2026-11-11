import fs from 'node:fs';
import path from 'node:path';

export interface EntityFtsSearchConfig {
  readonly baseTableName: string;
  readonly ftsTableName: string;
  readonly entityIdColumn: string;
  readonly primarySearchColumn: string;
  readonly secondarySearchColumn: string;
  readonly baseSecondarySourceColumn: string;
  readonly insertTriggerName: string;
  readonly updateTriggerName: string;
}

const CATALOG_FTS_CONFIG: EntityFtsSearchConfig = {
  baseTableName: 'products',
  ftsTableName: 'products_fts',
  entityIdColumn: 'product_id',
  primarySearchColumn: 'name_search',
  secondarySearchColumn: 'sku_search',
  baseSecondarySourceColumn: 'sku_search',
  insertTriggerName: 'trg_products_fts_after_insert',
  updateTriggerName: 'trg_products_fts_after_update',
};

/**
 * Generates parameterized FTS5 virtual table and SQLite sync trigger DDL without `content=` /
 * `rowid` coupling so `VACUUM` can never desync UUIDs from search hits (`T1.1` F1, reused in `T1.7`).
 */
export function buildEntityFtsSearchSql(config: EntityFtsSearchConfig): string[] {
  const fts = config.ftsTableName;
  const base = config.baseTableName;
  const idCol = config.entityIdColumn;
  const col1 = config.primarySearchColumn;
  const col2 = config.secondarySearchColumn;
  const src2 = config.baseSecondarySourceColumn;
  const insTrg = config.insertTriggerName;
  const updTrg = config.updateTriggerName;

  return [
    `DROP TRIGGER IF EXISTS "${insTrg}";`,
    `DROP TRIGGER IF EXISTS "${updTrg}";`,
    `DROP TABLE IF EXISTS "${fts}";`,
    [
      `CREATE VIRTUAL TABLE "${fts}" USING fts5(`,
      `  ${idCol} UNINDEXED,`,
      '  organization_id UNINDEXED,',
      `  ${col1},`,
      `  ${col2},`,
      "  tokenize = 'unicode61 remove_diacritics 0',",
      "  prefix = '2 3'",
      ');',
    ].join('\n'),
    [
      `CREATE TRIGGER "${insTrg}"`,
      `AFTER INSERT ON "${base}"`,
      'FOR EACH ROW',
      'WHEN NEW."deleted_at_ms" IS NULL',
      'BEGIN',
      `  INSERT INTO "${fts}" ("${idCol}", "organization_id", "${col1}", "${col2}")`,
      `  VALUES (NEW."id", NEW."organization_id", NEW."${col1}", COALESCE(NEW."${src2}", ''));`,
      'END;',
    ].join('\n'),
    [
      `CREATE TRIGGER "${updTrg}"`,
      `AFTER UPDATE ON "${base}"`,
      'FOR EACH ROW',
      'BEGIN',
      `  DELETE FROM "${fts}" WHERE "${idCol}" = OLD."id";`,
      `  INSERT INTO "${fts}" ("${idCol}", "organization_id", "${col1}", "${col2}")`,
      `  SELECT NEW."id", NEW."organization_id", NEW."${col1}", COALESCE(NEW."${src2}", '')`,
      '  WHERE NEW."deleted_at_ms" IS NULL;',
      'END;',
    ].join('\n'),
  ];
}

export function buildCatalogSearchFtsSql(): string[] {
  return buildEntityFtsSearchSql(CATALOG_FTS_CONFIG);
}

function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getLatestFtsTableDefinition(sqlContent: string, ftsTableName: string): string | null {
  const esc = escapeRegExp(ftsTableName);
  const createPattern = new RegExp(
    `\\bCREATE\\s+VIRTUAL\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"${esc}"|\`${esc}\`|${esc})\\s+USING\\s+fts5\\s*\\(([\\s\\S]*?)\\)\\s*;`,
    'gi',
  );
  const dropPattern = new RegExp(
    `\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:"${esc}"|\`${esc}\`|${esc})\\s*;`,
    'gi',
  );

  let latestCreate: { readonly body: string; readonly index: number } | null = null;
  for (const m of sqlContent.matchAll(createPattern)) {
    if (typeof m.index === 'number' && m[1] !== undefined) {
      latestCreate = { body: m[1], index: m.index };
    }
  }
  if (!latestCreate) {
    return null;
  }

  let latestDropIndex = -1;
  for (const d of sqlContent.matchAll(dropPattern)) {
    if (typeof d.index === 'number') {
      latestDropIndex = d.index;
    }
  }
  if (latestCreate.index <= latestDropIndex) {
    return null;
  }
  return latestCreate.body;
}

function getLatestTriggerBody(
  sqlContent: string,
  baseTableName: string,
  timingEvent: 'AFTER INSERT' | 'AFTER UPDATE',
): string | null {
  const escTable = escapeRegExp(baseTableName);
  const createPattern = new RegExp(
    `\\bCREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"([^"]+)"|\`([^\`]+)\`|([a-zA-Z_][a-zA-Z0-9_]*))\\s+${timingEvent}\\s+ON\\s+(?:"${escTable}"|\`${escTable}\`|${escTable}(?=[\\s;,(]|$))([\\s\\S]*?)\\bEND\\s*;`,
    'gi',
  );

  let latest: { readonly name: string; readonly body: string; readonly index: number } | null =
    null;
  for (const m of sqlContent.matchAll(createPattern)) {
    const name = m[1] ?? m[2] ?? m[3];
    if (name && m[4] !== undefined && typeof m.index === 'number') {
      latest = { name, body: m[4], index: m.index };
    }
  }
  if (!latest) {
    return null;
  }

  const escaped = escapeRegExp(latest.name);
  const dropPattern = new RegExp(
    `\\bDROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?(?:"${escaped}"|\`${escaped}\`|${escaped}(?=[\\s;]|$))`,
    'gi',
  );
  let latestDrop = -1;
  for (const d of sqlContent.matchAll(dropPattern)) {
    if (typeof d.index === 'number') {
      latestDrop = d.index;
    }
  }
  if (latest.index <= latestDrop) {
    return null;
  }
  return latest.body;
}

/**
 * Shared migration verifier for FTS5 search tables & UUID-keyed sync triggers.
 */
export function assertEntityFtsMigrationsComplete(
  migrationsDir: string,
  config: EntityFtsSearchConfig,
): string {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found at "${migrationsDir}"`);
  }

  const rawSql = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8'))
    .join('\n');

  const sqlContent = stripSqlComments(rawSql);
  const ftsBody = getLatestFtsTableDefinition(sqlContent, config.ftsTableName);
  if (ftsBody === null) {
    throw new Error(
      `Missing active FTS5 virtual table "${config.ftsTableName}" in SQLite migrations`,
    );
  }

  if (/\bcontent\s*=/i.test(ftsBody)) {
    throw new Error(
      `FTS5 virtual table "${config.ftsTableName}" must not use "content=" rowid coupling (VACUUM hazard)`,
    );
  }
  if (!new RegExp(`\\b${escapeRegExp(config.entityIdColumn)}\\s+UNINDEXED\\b`, 'i').test(ftsBody)) {
    throw new Error(
      `FTS5 table "${config.ftsTableName}" must declare "${config.entityIdColumn} UNINDEXED"`,
    );
  }
  if (!/\borganization_id\s+UNINDEXED\b/i.test(ftsBody)) {
    throw new Error(`FTS5 table "${config.ftsTableName}" must declare "organization_id UNINDEXED"`);
  }
  if (
    !new RegExp(`\\b${escapeRegExp(config.primarySearchColumn)}\\b`, 'i').test(ftsBody) ||
    !new RegExp(`\\b${escapeRegExp(config.secondarySearchColumn)}\\b`, 'i').test(ftsBody)
  ) {
    throw new Error(
      `FTS5 table "${config.ftsTableName}" must index both "${config.primarySearchColumn}" and "${config.secondarySearchColumn}"`,
    );
  }

  const escFts = escapeRegExp(config.ftsTableName);
  const escIdCol = escapeRegExp(config.entityIdColumn);
  const ftsTableRef = `(?:"${escFts}"|\`${escFts}\`|\\b${escFts}\\b)`;
  const deletedAtRef = '(?:NEW\\."deleted_at_ms"|NEW\\.`deleted_at_ms`|NEW\\.deleted_at_ms\\b)';
  const oldIdRef = '(?:OLD\\."id"|OLD\\.`id`|OLD\\.id\\b)';

  const insertBody = getLatestTriggerBody(sqlContent, config.baseTableName, 'AFTER INSERT');
  if (insertBody === null) {
    throw new Error(`Missing active AFTER INSERT FTS sync trigger on "${config.baseTableName}"`);
  }
  if (!new RegExp(`\\bINSERT\\s+INTO\\s+${ftsTableRef}`, 'i').test(insertBody)) {
    throw new Error(
      `AFTER INSERT trigger on "${config.baseTableName}" must insert into "${config.ftsTableName}"`,
    );
  }
  if (!new RegExp(`${deletedAtRef}\\s+IS\\s+NULL\\b`, 'i').test(insertBody)) {
    throw new Error(
      `AFTER INSERT trigger on "${config.baseTableName}" must guard NEW.deleted_at_ms IS NULL`,
    );
  }
  if (/\b(OLD|NEW)\."?rowid"?\b/i.test(insertBody)) {
    throw new Error(
      `AFTER INSERT trigger on "${config.baseTableName}" must not reference hidden rowid`,
    );
  }

  const updateBody = getLatestTriggerBody(sqlContent, config.baseTableName, 'AFTER UPDATE');
  if (updateBody === null) {
    throw new Error(`Missing active AFTER UPDATE FTS sync trigger on "${config.baseTableName}"`);
  }
  if (
    !new RegExp(
      `\\bDELETE\\s+FROM\\s+${ftsTableRef}\\s+WHERE\\s+(?:"${escIdCol}"|\`${escIdCol}\`|${escIdCol})\\s*=\\s*${oldIdRef}`,
      'i',
    ).test(updateBody)
  ) {
    throw new Error(
      `AFTER UPDATE trigger on "${config.baseTableName}" must delete stale "${config.ftsTableName}" rows by ${config.entityIdColumn} = OLD.id`,
    );
  }
  if (!new RegExp(`\\bINSERT\\s+INTO\\s+${ftsTableRef}`, 'i').test(updateBody)) {
    throw new Error(
      `AFTER UPDATE trigger on "${config.baseTableName}" must re-insert active rows into "${config.ftsTableName}"`,
    );
  }
  if (!new RegExp(`${deletedAtRef}\\s+IS\\s+NULL\\b`, 'i').test(updateBody)) {
    throw new Error(
      `AFTER UPDATE trigger on "${config.baseTableName}" must check NEW.deleted_at_ms IS NULL`,
    );
  }
  if (/\b(OLD|NEW)\."?rowid"?\b/i.test(updateBody)) {
    throw new Error(
      `AFTER UPDATE trigger on "${config.baseTableName}" must not reference hidden rowid`,
    );
  }

  return sqlContent;
}

/**
 * Verifies committed SQLite migrations maintain F1/F4 catalog FTS5 guarantees (`db:check`).
 */
export function assertCatalogSearchMigrationsComplete(migrationsDir: string): void {
  assertEntityFtsMigrationsComplete(migrationsDir, CATALOG_FTS_CONFIG);
}
