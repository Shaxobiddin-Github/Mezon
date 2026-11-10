import { DomainError } from './errors.js';

declare const UnixMsBrand: unique symbol;

/**
 * Unix Epoch timestamp in milliseconds represented as an immutable branded bigint.
 * Valid range is `[0n, 281_474_976_710_655n]` (48-bit unsigned integer matching RFC 9562).
 */
export type UnixMs = bigint & { readonly [UnixMsBrand]: typeof UnixMsBrand };

export const MIN_UNIX_MS = 0n as UnixMs;
export const MAX_UNIX_MS = 0xffffffffffffn as UnixMs;

const MAX_UNIX_MS_RAW = 0xffffffffffffn;
const MAX_UNIX_MS_STR_LEN = 15; // '281474976710655'.length === 15
const CANONICAL_UNSIGNED_INT_REGEX = /^(0|[1-9][0-9]*)$/;

export interface Clock {
  now(): UnixMs;
}

export interface RandomSource {
  nextBytes(length: number): Uint8Array;
}

export function unixMsFromBigInt(ms: bigint): UnixMs {
  if (typeof ms !== 'bigint' || ms < 0n || ms > MAX_UNIX_MS_RAW) {
    throw new DomainError('INVALID_TIMESTAMP');
  }
  return ms as UnixMs;
}

export function unixMsToBigInt(ms: UnixMs): bigint {
  return unixMsFromBigInt(ms);
}

export function addUnixMs(ms: UnixMs, deltaMs: bigint): UnixMs {
  const base = unixMsFromBigInt(ms);
  if (typeof deltaMs !== 'bigint') {
    throw new DomainError('INVALID_TIMESTAMP');
  }
  return unixMsFromBigInt((base as bigint) + deltaMs);
}

export function diffUnixMs(a: UnixMs, b: UnixMs): bigint {
  const validA = unixMsFromBigInt(a);
  const validB = unixMsFromBigInt(b);
  return (validA as bigint) - (validB as bigint);
}

export function serializeUnixMs(ms: UnixMs): string {
  return (unixMsFromBigInt(ms) as bigint).toString();
}

export function parseUnixMs(raw: string): UnixMs {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > MAX_UNIX_MS_STR_LEN ||
    !CANONICAL_UNSIGNED_INT_REGEX.test(raw)
  ) {
    throw new DomainError('INVALID_TIMESTAMP');
  }
  return unixMsFromBigInt(BigInt(raw));
}
