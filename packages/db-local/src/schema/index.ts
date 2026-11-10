import { SqliteSchemaRegistry } from '../registry.js';

/**
 * Local SQLite schema metadata registry.
 * T0.4 defines only schema foundation (no business tables yet).
 */
export const localSchemaRegistry = new SqliteSchemaRegistry();
