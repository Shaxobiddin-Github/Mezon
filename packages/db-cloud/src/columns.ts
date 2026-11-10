import { type Money, type Quantity, type UnixMs, type UuidV7 } from '@mezon/domain';
import { bigint, boolean, integer, text, uuid } from 'drizzle-orm/pg-core';

/**
 * 64-bit PostgreSQL `bigint` column using strict JS `bigint` mode.
 * `bigint(..., { mode: 'number' })` (`PgBigInt53`) is forbidden by the schema validator.
 */
export function pgBigint(name: string) {
  return bigint(name, { mode: 'bigint' });
}

export function pgMoney(name: string) {
  return bigint(name, { mode: 'bigint' }).$type<Money>();
}

export function pgQuantity(name: string) {
  return bigint(name, { mode: 'bigint' }).$type<Quantity>();
}

export function pgUnixMs(name: string) {
  return bigint(name, { mode: 'bigint' }).$type<UnixMs>();
}

export function pgInt(name: string) {
  return integer(name);
}

export function pgUuidV7(name: string) {
  return uuid(name).$type<UuidV7>();
}

/**
 * 58-character canonical HLC column.
 * `PgSchemaRegistry.defineTable` automatically adds `CHECK (length(col) = 58)`.
 */
export function pgHlc(name: string) {
  return text(name);
}

export function pgBoolean(name: string) {
  return boolean(name);
}
