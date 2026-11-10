import fs from 'node:fs';
import path from 'node:path';
import type { PgTableMetadata } from './registry.js';

export const PG_APP_ROLE_NAME = 'mezon_app';
export const PG_TENANT_SETTING_KEY = 'app.organization_id';

const IDENTIFIER_REGEX = /^[a-z_][a-z0-9_]{0,62}$/;

function quoteIdent(name: string): string {
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new RangeError(`Invalid PostgreSQL SQL identifier: "${name}"`);
  }
  return `"${name}"`;
}

/**
 * Generates PostgreSQL RLS DDL for an organization-scoped table:
 * - `ENABLE ROW LEVEL SECURITY`
 * - `FORCE ROW LEVEL SECURITY` (enforces policy even on table owner)
 * - Fail-closed `FOR ALL TO mezon_app` policy with both `USING` and `WITH CHECK`
 *   using `mezon_current_organization_id()` (`current_setting('app.organization_id', true)`).
 * - Explicit DML grants for `mezon_app`.
 *
 * Note: RLS enforces isolation at the `organization_id` level. Store-level (`store_id`)
 * isolation is enforced at the application/repository layer.
 */
export function buildTenantRlsSql(
  tableName: string,
  organizationColumn: string = 'organization_id',
): string[] {
  const qTable = quoteIdent(tableName);
  const qOrgCol = quoteIdent(organizationColumn);
  const policyName = quoteIdent(`${tableName}_tenant_isolation`);
  const qRole = quoteIdent(PG_APP_ROLE_NAME);

  return [
    `ALTER TABLE ${qTable} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${qTable} FORCE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS ${policyName} ON ${qTable};`,
    `CREATE POLICY ${policyName} ON ${qTable} AS PERMISSIVE FOR ALL TO ${qRole} USING (${qOrgCol} = mezon_current_organization_id()) WITH CHECK (${qOrgCol} = mezon_current_organization_id());`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${qTable} TO ${qRole};`,
  ];
}

/**
 * Verifies that committed SQL migrations cover RLS (`ENABLE`, `FORCE`, `CREATE POLICY ... WITH CHECK`,
 * and `GRANT` or `mezon_apply_tenant_rls(...)`) for every registered synced PostgreSQL table.
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

  const sqlContent = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8'))
    .join('\n');

  for (const meta of syncedTables) {
    const escaped = meta.tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const helperPattern = new RegExp(
      `mezon_apply_tenant_rls\\(\\s*'(?:public\\.)?"?${escaped}"?'`,
      'i',
    );
    if (helperPattern.test(sqlContent)) {
      continue;
    }

    const enablePattern = new RegExp(
      `ALTER\\s+TABLE\\s+(?:public\\.)?"?${escaped}"?\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
      'i',
    );
    const forcePattern = new RegExp(
      `ALTER\\s+TABLE\\s+(?:public\\.)?"?${escaped}"?\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`,
      'i',
    );
    const policyPattern = new RegExp(
      `CREATE\\s+POLICY\\s+[^;]+\\s+ON\\s+(?:public\\.)?"?${escaped}"?[\\s\\S]+?USING\\s*\\([\\s\\S]+?WITH\\s+CHECK\\s*\\(`,
      'i',
    );
    const grantPattern = new RegExp(
      `GRANT\\s+[^;]+\\s+ON\\s+(?:TABLE\\s+)?(?:public\\.)?"?${escaped}"?\\s+TO\\s+"?${PG_APP_ROLE_NAME}"?`,
      'i',
    );

    if (
      !enablePattern.test(sqlContent) ||
      !forcePattern.test(sqlContent) ||
      !policyPattern.test(sqlContent) ||
      !grantPattern.test(sqlContent)
    ) {
      throw new Error(
        `Synced table "${meta.tableName}" is missing complete RLS migration (ENABLE + FORCE + CREATE POLICY USING/WITH CHECK + GRANT TO ${PG_APP_ROLE_NAME})`,
      );
    }
  }
}
