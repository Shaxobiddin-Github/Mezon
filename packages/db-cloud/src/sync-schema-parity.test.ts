import { MONOTONE_TRANSITION_RULES, SYNC_ENTITY_PAYLOAD_SCHEMAS } from '@mezon/sync';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  buildDrizzleForeignReferencesMap,
  cloudSchemaRegistry,
  extractPgErrorCode,
  snakeToCamel,
} from './index.js';

describe('@mezon/db-cloud - Schema Registry, Foreign Keys & MONOTONE Parity (R2, R3, R7)', () => {
  it('R7: every synced table in cloudSchemaRegistry has a strict Zod payload schema with matching columns', () => {
    const syncedTables = cloudSchemaRegistry
      .all()
      .filter((m) => m.tableClass !== 'LOCAL' && !m.tableName.startsWith('cloud_'));

    expect(syncedTables.length).toBe(36);

    for (const tableMeta of syncedTables) {
      const schema = SYNC_ENTITY_PAYLOAD_SCHEMAS[tableMeta.tableName];
      expect(schema, `Missing Zod payload schema for table "${tableMeta.tableName}"`).toBeDefined();

      const config = getTableConfig(tableMeta.table);
      const expectedColumnKeys = config.columns.map((c) => snakeToCamel(c.name)).sort();

      const shapeObj =
        schema && typeof schema === 'object' && 'shape' in schema
          ? ((schema as { readonly shape: Record<string, unknown> }).shape ?? {})
          : {};
      const schemaKeys = Object.keys(shapeObj).sort();

      // Every table column must exist in schema keys
      for (const colKey of expectedColumnKeys) {
        expect(
          schemaKeys,
          `Table "${tableMeta.tableName}" column "${colKey}" is missing in Zod payload schema`,
        ).toContain(colKey);
      }

      // Schema must not contain extra unknown keys not in the database table
      for (const sKey of schemaKeys) {
        expect(
          expectedColumnKeys,
          `Zod payload schema for "${tableMeta.tableName}" has extra unknown key "${sKey}"`,
        ).toContain(sKey);
      }
    }
  });

  it('R2: every MONOTONE table in cloudSchemaRegistry has a defined transition rule in MONOTONE_TRANSITION_RULES', () => {
    const monotoneTables = cloudSchemaRegistry.all().filter((m) => m.tableClass === 'MONOTONE');

    expect(monotoneTables.length).toBe(6);

    for (const tableMeta of monotoneTables) {
      const rule = MONOTONE_TRANSITION_RULES[tableMeta.tableName];
      expect(
        rule,
        `MONOTONE table "${tableMeta.tableName}" must have a rule in MONOTONE_TRANSITION_RULES`,
      ).toBeDefined();
      expect(rule.isMonotone).toBe(true);
      expect(rule.allowableUpdateColumns.length).toBeGreaterThan(0);
    }
  });

  it('R3: automatically reflects 100% of foreign keys defined in Drizzle domain tables', () => {
    const fkMap = buildDrizzleForeignReferencesMap(cloudSchemaRegistry);

    let totalDrizzleFks = 0;
    let mappedFks = 0;

    for (const tableMeta of cloudSchemaRegistry.all()) {
      if (tableMeta.tableClass === 'LOCAL') continue;
      const config = getTableConfig(tableMeta.table);

      for (const fk of config.foreignKeys) {
        const ref = fk.reference();
        const foreignTable = getTableConfig(ref.foreignTable).name;
        for (const col of ref.columns) {
          if (
            col.name === 'organization_id' ||
            col.name === 'store_id' ||
            col.name === 'device_id'
          ) {
            continue;
          }
          totalDrizzleFks += 1;
          const tableRefs = fkMap[tableMeta.tableName];
          expect(tableRefs).toBeDefined();
          const found = tableRefs?.find(
            (r) => r.columnName === col.name && r.targetEntity === foreignTable,
          );
          expect(
            found,
            `FK ${tableMeta.tableName}.${col.name} -> ${foreignTable} missing in mapped references`,
          ).toBeDefined();
          mappedFks += 1;
        }
      }
    }

    expect(mappedFks).toBe(totalDrizzleFks);
    expect(mappedFks).toBeGreaterThanOrEqual(50);
  });

  it('F1: extractPgErrorCode accurately extracts SQLSTATE codes from both raw and DrizzleQueryError wrapped errors', () => {
    // 1. Unwrapped raw error
    const rawFkErr = { code: '23503', message: 'foreign key violation' };
    expect(extractPgErrorCode(rawFkErr)).toBe('23503');

    // 2. Wrapped in cause (DrizzleQueryError pattern)
    const wrappedTransient = new Error('Query failed', {
      cause: { code: '40P01', message: 'deadlock detected' },
    });
    expect(extractPgErrorCode(wrappedTransient)).toBe('40P01');

    // 3. Doubly wrapped
    const doubleWrapped = new Error('Outer', {
      cause: new Error('Middle', {
        cause: { code: '23514', message: 'check constraint violation' },
      }),
    });
    expect(extractPgErrorCode(doubleWrapped)).toBe('23514');

    // 4. Non-error or error without code
    expect(extractPgErrorCode(null)).toBeUndefined();
    expect(extractPgErrorCode(undefined)).toBeUndefined();
    expect(extractPgErrorCode(new Error('Simple error without code'))).toBeUndefined();
  });
});
