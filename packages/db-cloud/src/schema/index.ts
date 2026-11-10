import { PgSchemaRegistry } from '../registry.js';

/**
 * Cloud PostgreSQL schema metadata registry.
 * T0.4 defines only schema foundation (no business tables yet).
 */
export const cloudSchemaRegistry = new PgSchemaRegistry();
