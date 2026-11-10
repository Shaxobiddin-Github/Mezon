import {
  type Money,
  type Quantity,
  type UnixMs,
  type UuidV7,
  parseHlc,
  parseUuidV7,
  serializeHlc,
  unixMsFromBigInt,
} from '@mezon/domain';
import { customType, integer } from 'drizzle-orm/sqlite-core';

export type SqliteColumnKind = 'bigint' | 'int' | 'uuid' | 'hlc';

const registeredFromDrivers = new WeakMap<object, SqliteColumnKind>();

function registerSqliteColumnKind(
  fromDriverFn: (...args: never[]) => unknown,
  kind: SqliteColumnKind,
): void {
  registeredFromDrivers.set(fromDriverFn, kind);
}

export function getSqliteCustomColumnKind(col: unknown): SqliteColumnKind | undefined {
  if (typeof col !== 'object' || col === null) {
    return undefined;
  }
  const mapFrom = (col as { readonly mapFrom?: unknown }).mapFrom;
  if (typeof mapFrom === 'function') {
    return registeredFromDrivers.get(mapFrom);
  }
  return undefined;
}

const BIGINT_FROM_DRIVER = (value: bigint | number): bigint => {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  throw new TypeError(`Expected integer/bigint from SQLite driver, received ${typeof value}`);
};
registerSqliteColumnKind(BIGINT_FROM_DRIVER, 'bigint');

const INT_FROM_DRIVER = (value: bigint | number): number => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    const num = Number(value);
    if (!Number.isSafeInteger(num)) {
      throw new RangeError(`SQLite integer ${value.toString()} exceeds JS safe integer range`);
    }
    return num;
  }
  throw new TypeError(`Expected integer from SQLite driver, received ${typeof value}`);
};
registerSqliteColumnKind(INT_FROM_DRIVER, 'int');

const UNIX_MS_FROM_DRIVER = (value: bigint | number): UnixMs => {
  return unixMsFromBigInt(BIGINT_FROM_DRIVER(value));
};
registerSqliteColumnKind(UNIX_MS_FROM_DRIVER, 'bigint');

const UUID_V7_FROM_DRIVER = (value: string): UuidV7 => {
  return parseUuidV7(value);
};
registerSqliteColumnKind(UUID_V7_FROM_DRIVER, 'uuid');

const HLC_FROM_DRIVER = (value: string): string => {
  return serializeHlc(parseHlc(value));
};
registerSqliteColumnKind(HLC_FROM_DRIVER, 'hlc');

/**
 * 64-bit signed SQLite INTEGER mapped strictly to JS `bigint`.
 * Requires `defaultSafeIntegers(true)` on the `better-sqlite3` connection so values
 * exceeding `Number.MAX_SAFE_INTEGER` (2^53 - 1) never lose precision.
 * `SqliteSchemaRegistry.defineTable` automatically adds `CHECK (typeof(col) = 'integer')`.
 */
export const sqliteBigint = (name: string) =>
  customType<{ data: bigint; driverData: bigint | number }>({
    dataType: () => 'integer',
    toDriver: (value: bigint): bigint => {
      if (typeof value !== 'bigint') {
        throw new TypeError(`Expected bigint value for SQLite column "${name}"`);
      }
      return value;
    },
    fromDriver: BIGINT_FROM_DRIVER,
  })(name);

export const sqliteMoney = (name: string) =>
  customType<{ data: Money; driverData: bigint | number }>({
    dataType: () => 'integer',
    toDriver: (value: Money): bigint => {
      if (typeof value !== 'bigint') {
        throw new TypeError(`Expected Money (bigint) for SQLite column "${name}"`);
      }
      return value;
    },
    fromDriver: BIGINT_FROM_DRIVER as (value: bigint | number) => Money,
  })(name);

export const sqliteQuantity = (name: string) =>
  customType<{ data: Quantity; driverData: bigint | number }>({
    dataType: () => 'integer',
    toDriver: (value: Quantity): bigint => {
      if (typeof value !== 'bigint') {
        throw new TypeError(`Expected Quantity (bigint) for SQLite column "${name}"`);
      }
      return value;
    },
    fromDriver: BIGINT_FROM_DRIVER as (value: bigint | number) => Quantity,
  })(name);

export const sqliteUnixMs = (name: string) =>
  customType<{ data: UnixMs; driverData: bigint | number }>({
    dataType: () => 'integer',
    toDriver: (value: UnixMs): bigint => unixMsFromBigInt(value),
    fromDriver: UNIX_MS_FROM_DRIVER,
  })(name);

export const sqliteInt = (name: string) =>
  customType<{ data: number; driverData: bigint | number }>({
    dataType: () => 'integer',
    toDriver: (value: number): number => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new TypeError(`Expected safe integer number for SQLite column "${name}"`);
      }
      return value;
    },
    fromDriver: INT_FROM_DRIVER,
  })(name);

export const sqliteUuidV7 = (name: string) =>
  customType<{ data: UuidV7; driverData: string }>({
    dataType: () => 'text',
    toDriver: (value: UuidV7): string => parseUuidV7(value),
    fromDriver: UUID_V7_FROM_DRIVER,
  })(name);

export const sqliteHlc = (name: string) =>
  customType<{ data: string; driverData: string }>({
    dataType: () => 'text',
    toDriver: (value: string): string => serializeHlc(parseHlc(value)),
    fromDriver: HLC_FROM_DRIVER,
  })(name);

export function sqliteBoolean(name: string) {
  return integer(name, { mode: 'boolean' });
}
