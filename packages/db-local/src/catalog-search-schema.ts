import fs from 'node:fs';
import path from 'node:path';

/**
 * Generates FTS5 virtual table and SQLite sync trigger DDL for catalog product search:
 * - `products_fts` stores `product_id UNINDEXED` and `organization_id UNINDEXED` (no `content=` / `rowid`
 *   coupling so `VACUUM` can never desync UUIDs from search hits — T1.1 adjustment F1).
 * - Sync triggers maintain exact 1:1 parity between active rows in `products` (`deleted_at_ms IS NULL`)
 *   and rows in `products_fts`.
 */
export function buildCatalogSearchFtsSql(): string[] {
  return [
    `DROP TRIGGER IF EXISTS "trg_products_fts_after_insert";`,
    `DROP TRIGGER IF EXISTS "trg_products_fts_after_update";`,
    `DROP TABLE IF EXISTS "products_fts";`,
    [
      'CREATE VIRTUAL TABLE "products_fts" USING fts5(',
      '  product_id UNINDEXED,',
      '  organization_id UNINDEXED,',
      '  name_search,',
      '  sku_search,',
      "  tokenize = 'unicode61 remove_diacritics 0',",
      "  prefix = '2 3'",
      ');',
    ].join('\n'),
    [
      'CREATE TRIGGER "trg_products_fts_after_insert"',
      'AFTER INSERT ON "products"',
      'FOR EACH ROW',
      'WHEN NEW."deleted_at_ms" IS NULL',
      'BEGIN',
      '  INSERT INTO "products_fts" ("product_id", "organization_id", "name_search", "sku_search")',
      `  VALUES (NEW."id", NEW."organization_id", NEW."name_search", COALESCE(NEW."sku_search", ''));`,
      'END;',
    ].join('\n'),
    [
      'CREATE TRIGGER "trg_products_fts_after_update"',
      'AFTER UPDATE ON "products"',
      'FOR EACH ROW',
      'BEGIN',
      '  DELETE FROM "products_fts" WHERE "product_id" = OLD."id";',
      '  INSERT INTO "products_fts" ("product_id", "organization_id", "name_search", "sku_search")',
      `  SELECT NEW."id", NEW."organization_id", NEW."name_search", COALESCE(NEW."sku_search", '')`,
      '  WHERE NEW."deleted_at_ms" IS NULL;',
      'END;',
    ].join('\n'),
  ];
}

function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function getLatestFtsTableDefinition(sqlContent: string): string | null {
  const createPattern =
    /\bCREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"products_fts"|`products_fts`|products_fts)\s+USING\s+fts5\s*\(([\s\S]*?)\)\s*;/gi;
  const dropPattern =
    /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"products_fts"|`products_fts`|products_fts)\s*;/gi;

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
  timingEvent: 'AFTER INSERT' | 'AFTER UPDATE',
): string | null {
  const createPattern = new RegExp(
    `\\bCREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"([^"]+)"|\`([^\`]+)\`|([a-zA-Z_][a-zA-Z0-9_]*))\\s+${timingEvent}\\s+ON\\s+(?:"products"|\`products\`|products(?:(?=[\\s;,(]|$)))([\\s\\S]*?)\\bEND\\s*;`,
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

  const escaped = latest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
 * Verifies committed SQLite migrations maintain F1/F4 catalog FTS5 guarantees (`db:check`):
 * - `products_fts` FTS5 virtual table exists with `product_id UNINDEXED`, `organization_id UNINDEXED`,
 *   `name_search`, `sku_search`, and ZERO `content=` external/contentless `rowid` coupling.
 * - Active `AFTER INSERT` and `AFTER UPDATE` triggers on `products` sync `products_fts` strictly by
 *   `product_id` (no `OLD.rowid` / `NEW.rowid`) while honoring `deleted_at_ms IS NULL`.
 */
export function assertCatalogSearchMigrationsComplete(migrationsDir: string): void {
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
  const ftsBody = getLatestFtsTableDefinition(sqlContent);
  if (ftsBody === null) {
    throw new Error('Missing active FTS5 virtual table "products_fts" in SQLite migrations');
  }

  if (/\bcontent\s*=/i.test(ftsBody)) {
    throw new Error(
      'FTS5 virtual table "products_fts" must not use "content=" rowid coupling (VACUUM hazard)',
    );
  }
  if (!/\bproduct_id\s+UNINDEXED\b/i.test(ftsBody)) {
    throw new Error('FTS5 table "products_fts" must declare "product_id UNINDEXED"');
  }
  if (!/\borganization_id\s+UNINDEXED\b/i.test(ftsBody)) {
    throw new Error('FTS5 table "products_fts" must declare "organization_id UNINDEXED"');
  }
  if (!/\bname_search\b/i.test(ftsBody) || !/\bsku_search\b/i.test(ftsBody)) {
    throw new Error('FTS5 table "products_fts" must index both "name_search" and "sku_search"');
  }

  const ftsTableRef = '(?:"products_fts"|`products_fts`|\\bproducts_fts\\b)';
  const deletedAtRef = '(?:NEW\\."deleted_at_ms"|NEW\\.`deleted_at_ms`|NEW\\.deleted_at_ms\\b)';
  const oldIdRef = '(?:OLD\\."id"|OLD\\.`id`|OLD\\.id\\b)';

  const insertBody = getLatestTriggerBody(sqlContent, 'AFTER INSERT');
  if (insertBody === null) {
    throw new Error('Missing active AFTER INSERT FTS sync trigger on "products"');
  }
  if (!new RegExp(`\\bINSERT\\s+INTO\\s+${ftsTableRef}`, 'i').test(insertBody)) {
    throw new Error('AFTER INSERT trigger on "products" must insert into "products_fts"');
  }
  if (!new RegExp(`${deletedAtRef}\\s+IS\\s+NULL\\b`, 'i').test(insertBody)) {
    throw new Error('AFTER INSERT trigger on "products" must guard NEW.deleted_at_ms IS NULL');
  }
  if (/\b(OLD|NEW)\."?rowid"?\b/i.test(insertBody)) {
    throw new Error('AFTER INSERT trigger on "products" must not reference hidden rowid');
  }

  const updateBody = getLatestTriggerBody(sqlContent, 'AFTER UPDATE');
  if (updateBody === null) {
    throw new Error('Missing active AFTER UPDATE FTS sync trigger on "products"');
  }
  if (
    !new RegExp(
      `\\bDELETE\\s+FROM\\s+${ftsTableRef}\\s+WHERE\\s+(?:"product_id"|\`product_id\`|product_id)\\s*=\\s*${oldIdRef}`,
      'i',
    ).test(updateBody)
  ) {
    throw new Error(
      'AFTER UPDATE trigger on "products" must delete stale "products_fts" rows by product_id = OLD.id',
    );
  }
  if (!new RegExp(`\\bINSERT\\s+INTO\\s+${ftsTableRef}`, 'i').test(updateBody)) {
    throw new Error(
      'AFTER UPDATE trigger on "products" must re-insert active rows into "products_fts"',
    );
  }
  if (!new RegExp(`${deletedAtRef}\\s+IS\\s+NULL\\b`, 'i').test(updateBody)) {
    throw new Error('AFTER UPDATE trigger on "products" must check NEW.deleted_at_ms IS NULL');
  }
  if (/\b(OLD|NEW)\."?rowid"?\b/i.test(updateBody)) {
    throw new Error('AFTER UPDATE trigger on "products" must not reference hidden rowid');
  }
}
