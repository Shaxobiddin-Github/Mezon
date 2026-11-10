import fs from 'node:fs';
import path from 'node:path';
import type { PgTableMetadata } from './registry.js';

export const PG_APP_ROLE_NAME = 'mezon_app';
export const PG_TENANT_SETTING_KEY = 'app.organization_id';

export type SyncedTableClass = 'FACT' | 'ATTR' | 'MONOTONE';

const IDENTIFIER_REGEX = /^[a-z_][a-z0-9_]{0,62}$/;

function quoteIdent(name: string): string {
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new RangeError(`Invalid PostgreSQL SQL identifier: "${name}"`);
  }
  return `"${name}"`;
}

/**
 * Returns allowed PostgreSQL table privileges for a synced table class:
 * - `FACT`: `SELECT, INSERT` (immutable facts — no UPDATE, no physical DELETE)
 * - `ATTR` / `MONOTONE`: `SELECT, INSERT, UPDATE` (tombstone only — no physical DELETE)
 *
 * Monotone transition guards (e.g. irreversible `voided_at` on `MONOTONE` tables) will be enforced
 * at the database layer in later tasks.
 */
export function getTenantPrivilegesForClass(
  tableClass: SyncedTableClass,
): 'SELECT, INSERT' | 'SELECT, INSERT, UPDATE' {
  switch (tableClass) {
    case 'FACT':
      return 'SELECT, INSERT';
    case 'ATTR':
    case 'MONOTONE':
      return 'SELECT, INSERT, UPDATE';
    default: {
      const exhaustive: never = tableClass;
      throw new RangeError(
        `Unsupported synced table class for RLS privileges: ${String(exhaustive)}`,
      );
    }
  }
}

/**
 * Generates idempotent PostgreSQL RLS and class-based privilege DDL for a tenant-scoped table:
 * - `ENABLE ROW LEVEL SECURITY`
 * - `FORCE ROW LEVEL SECURITY` (enforces policy even on table owner)
 * - Fail-closed `FOR ALL TO mezon_app` policy with both `USING` and `WITH CHECK`
 *   using `mezon_current_organization_id()` (`current_setting('app.organization_id', true)`).
 * - `REVOKE ALL ON TABLE ... FROM mezon_app` followed by class-appropriate `GRANT`.
 *
 * Note: RLS enforces isolation at the `organization_id` level. Store-level (`store_id`)
 * isolation is enforced at the application/repository layer. Monotone column transitions on
 * `MONOTONE` tables will be constrained at the DB layer in later tasks.
 */
export function buildTenantRlsSql(
  tableName: string,
  tableClass: SyncedTableClass,
  organizationColumn: string = 'organization_id',
): string[] {
  const qTable = quoteIdent(tableName);
  const qOrgCol = quoteIdent(organizationColumn);
  const policyName = quoteIdent(`${tableName}_tenant_isolation`);
  const qRole = quoteIdent(PG_APP_ROLE_NAME);
  const privileges = getTenantPrivilegesForClass(tableClass);

  return [
    `ALTER TABLE ${qTable} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${qTable} FORCE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS ${policyName} ON ${qTable};`,
    `CREATE POLICY ${policyName} ON ${qTable} AS PERMISSIVE FOR ALL TO ${qRole} USING (${qOrgCol} = mezon_current_organization_id()) WITH CHECK (${qOrgCol} = mezon_current_organization_id());`,
    `REVOKE ALL ON TABLE ${qTable} FROM ${qRole};`,
    `GRANT ${privileges} ON TABLE ${qTable} TO ${qRole};`,
  ];
}

function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function parseGrantPrivileges(rawList: string): string[] {
  return rawList
    .split(',')
    .map(
      (part) =>
        part
          .trim()
          .split(/[\s(]+/)[0]
          ?.toUpperCase() ?? '',
    )
    .filter((token) => token.length > 0);
}

/**
 * Verifies that committed SQL migrations cover RLS (`ENABLE`, `FORCE`, `CREATE POLICY ... WITH CHECK`),
 * idempotent `REVOKE ALL` + exact class-based DML privileges (`FACT`: `SELECT, INSERT`; `ATTR`/`MONOTONE`:
 * `SELECT, INSERT, UPDATE`; never `DELETE`/`ALL` on any synced table), or valid `mezon_apply_tenant_rls(...)`
 * invocations matching each registered synced table's class.
 */
export function assertRlsMigrationsComplete(
  migrationsDir: string,
  tables: readonly PgTableMetadata[],
): void {
  const syncedTables = tables.filter((t) => t.tableClass !== 'LOCAL');
  if (syncedTables.length === 0) {
    return;
  }

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

  for (const meta of syncedTables) {
    const escaped = meta.tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tableRef = `(?:public\\.)?(?:"${escaped}"|${escaped}(?=[\\s;,)]|$))`;
    const expectedPrivs =
      meta.tableClass === 'FACT' ? ['SELECT', 'INSERT'] : ['SELECT', 'INSERT', 'UPDATE'];

    // 1. Validate all mezon_apply_tenant_rls(...) calls referencing this table
    const helperPattern = new RegExp(
      `mezon_apply_tenant_rls\\(\\s*'(?:public\\.)?(?:"${escaped}"|${escaped})'\\s*([^)]*)\\)`,
      'gi',
    );
    let validHelperCalls = 0;
    for (const match of sqlContent.matchAll(helperPattern)) {
      const restArgs = (match[1] ?? '').trim();
      const secondArgMatch = /^,\s*'([^']*)'(?:\s*,\s*'[^']*')?$/i.exec(restArgs);
      const invokedClass = secondArgMatch?.[1]?.trim().toUpperCase();
      if (!invokedClass) {
        throw new Error(
          `Migration invokes mezon_apply_tenant_rls("${meta.tableName}") without required literal table_class argument (expected "${meta.tableClass}")`,
        );
      }
      if (invokedClass !== meta.tableClass) {
        throw new Error(
          `Synced table "${meta.tableName}" is registered as "${meta.tableClass}", but migration invokes mezon_apply_tenant_rls with class "${invokedClass}"`,
        );
      }
      validHelperCalls += 1;
    }

    // 2. Scan all explicit GRANT statements targeting this table (fail on forbidden UPDATE on FACT or DELETE/ALL on any synced table)
    const grantPattern = new RegExp(
      `\\bGRANT\\s+([^;]+?)\\s+ON\\s+(?:TABLE\\s+)?${tableRef}\\s+TO\\s+([^;\\s]+)`,
      'gi',
    );
    const grantedToApp = new Set<string>();
    let firstGrantIndex = Number.POSITIVE_INFINITY;

    for (const grantMatch of sqlContent.matchAll(grantPattern)) {
      const privTokens = parseGrantPrivileges(grantMatch[1] ?? '');
      const targetRole = (grantMatch[2] ?? '').replace(/^"|"$/g, '').toLowerCase();

      for (const priv of privTokens) {
        if (priv === 'DELETE' || priv === 'ALL' || priv === 'TRUNCATE') {
          throw new Error(
            `Forbidden privilege "${priv}" granted on synced table "${meta.tableName}" (${meta.tableClass})`,
          );
        }
        if (meta.tableClass === 'FACT' && priv === 'UPDATE') {
          throw new Error(
            `Forbidden privilege "UPDATE" granted on immutable FACT table "${meta.tableName}"`,
          );
        }
        if (!expectedPrivs.includes(priv)) {
          throw new Error(
            `Unexpected privilege "${priv}" granted on synced table "${meta.tableName}" (${meta.tableClass})`,
          );
        }
        if (targetRole === PG_APP_ROLE_NAME) {
          grantedToApp.add(priv);
          if (typeof grantMatch.index === 'number' && grantMatch.index < firstGrantIndex) {
            firstGrantIndex = grantMatch.index;
          }
        }
      }
    }

    if (validHelperCalls > 0) {
      continue;
    }

    // 3. Explicit RLS + REVOKE ALL + class-matched GRANT verification
    const enablePattern = new RegExp(
      `ALTER\\s+TABLE\\s+${tableRef}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
      'i',
    );
    const forcePattern = new RegExp(
      `ALTER\\s+TABLE\\s+${tableRef}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`,
      'i',
    );
    const policyPattern = new RegExp(
      `CREATE\\s+POLICY\\s+[^;]+\\s+ON\\s+${tableRef}[\\s\\S]+?USING\\s*\\([\\s\\S]+?WITH\\s+CHECK\\s*\\(`,
      'i',
    );
    const revokePattern = new RegExp(
      `\\bREVOKE\\s+ALL(?:\\s+PRIVILEGES)?\\s+ON\\s+(?:TABLE\\s+)?${tableRef}\\s+FROM\\s+"?${PG_APP_ROLE_NAME}"?`,
      'i',
    );
    const revokeMatch = revokePattern.exec(sqlContent);

    const hasExactExpectedGrants =
      expectedPrivs.every((priv) => grantedToApp.has(priv)) &&
      grantedToApp.size === expectedPrivs.length;

    const hasPriorRevoke =
      revokeMatch !== null &&
      typeof revokeMatch.index === 'number' &&
      revokeMatch.index < firstGrantIndex;

    if (
      !enablePattern.test(sqlContent) ||
      !forcePattern.test(sqlContent) ||
      !policyPattern.test(sqlContent) ||
      !hasPriorRevoke ||
      !hasExactExpectedGrants
    ) {
      throw new Error(
        `Synced table "${meta.tableName}" (${meta.tableClass}) is missing complete RLS or class-matched REVOKE ALL + GRANT (${expectedPrivs.join(', ')}) TO ${PG_APP_ROLE_NAME}`,
      );
    }
  }
}
