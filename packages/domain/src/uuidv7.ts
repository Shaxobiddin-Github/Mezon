import {
  MAX_UNIX_MS,
  type Clock,
  type RandomSource,
  type UnixMs,
  unixMsFromBigInt,
} from './clock.js';
import { DomainError } from './errors.js';

declare const UuidV7Brand: unique symbol;

/**
 * Canonical lowercase RFC 9562 UUIDv7 string (`xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx`).
 */
export type UuidV7 = string & { readonly [UuidV7Brand]: typeof UuidV7Brand };

export interface IdGenerator {
  nextId(): UuidV7;
}

export interface MonotonicUuidV7State {
  readonly lastTimestampMs: UnixMs;
  readonly counter: number;
}

export interface MonotonicUuidV7StepResult {
  readonly id: UuidV7;
  readonly state: MonotonicUuidV7State;
}

export interface MonotonicUuidV7GeneratorOptions {
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly initialLastMs?: UnixMs;
}

export const UUID_V7_RANDOM_BYTES_LENGTH = 10;
export const MAX_UUID_V7_COUNTER = 0xffffff; // 24-bit unsigned max (16,777,215)

const HEX_DIGITS = '0123456789abcdef';
const CANONICAL_UUID_SHAPE_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VALID_VARIANT_NIBBLES = new Set(['8', '9', 'a', 'b']);
const MAX_UNIX_MS_RAW = MAX_UNIX_MS as bigint;

function bytesToHex(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    out += HEX_DIGITS.charAt(b >> 4) + HEX_DIGITS.charAt(b & 0x0f);
  }
  return out;
}

function formatUuidFromTsAndTail(tsMs: bigint, tail10: Uint8Array): UuidV7 {
  const tsHex = tsMs.toString(16).padStart(12, '0');
  const part1 = tsHex.slice(0, 8);
  const part2 = tsHex.slice(8, 12);
  const part3 = bytesToHex(tail10, 0, 2);
  const part4 = bytesToHex(tail10, 2, 4);
  const part5 = bytesToHex(tail10, 4, 10);
  return `${part1}-${part2}-${part3}-${part4}-${part5}` as UuidV7;
}

function hexNibble(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) {
    return code - 48;
  }
  if (code >= 97 && code <= 102) {
    return code - 87;
  }
  throw new DomainError('INVALID_UUID_FORMAT');
}

function assertValidRandomBytes(randomBytes: Uint8Array): void {
  if (!(randomBytes instanceof Uint8Array) || randomBytes.length !== UUID_V7_RANDOM_BYTES_LENGTH) {
    throw new DomainError('INVALID_RANDOM_BYTES');
  }
}

/**
 * Pure stateless RFC 9562 UUIDv7 encoding from explicit 48-bit Unix ms timestamp and 10 random bytes.
 * Sets version (`0b0111`) in octet 6 high nibble and variant (`0b10`) in octet 8 top 2 bits.
 */
export function encodeUuidV7(timestampMs: UnixMs, randomBytes: Uint8Array): UuidV7 {
  const ts = unixMsFromBigInt(timestampMs) as bigint;
  assertValidRandomBytes(randomBytes);

  const tail = new Uint8Array(10);
  tail[0] = 0x70 | (randomBytes[0] & 0x0f);
  tail[1] = randomBytes[1];
  tail[2] = 0x80 | (randomBytes[2] & 0x3f);
  for (let i = 3; i < 10; i++) {
    tail[i] = randomBytes[i];
  }
  return formatUuidFromTsAndTail(ts, tail);
}

/**
 * Validates and parses a canonical lowercase UUIDv7 string.
 * Rejects non-canonical uppercase/punctuation (`INVALID_UUID_FORMAT`),
 * non-v7 version (`INVALID_UUID_VERSION`), and non-RFC variant (`INVALID_UUID_VARIANT`).
 */
export function parseUuidV7(raw: string): UuidV7 {
  if (typeof raw !== 'string' || !CANONICAL_UUID_SHAPE_REGEX.test(raw)) {
    throw new DomainError('INVALID_UUID_FORMAT');
  }
  if (raw.charAt(14) !== '7') {
    throw new DomainError('INVALID_UUID_VERSION');
  }
  if (!VALID_VARIANT_NIBBLES.has(raw.charAt(19))) {
    throw new DomainError('INVALID_UUID_VARIANT');
  }
  return raw as UuidV7;
}

export function isValidUuidV7(raw: string): raw is UuidV7 {
  if (typeof raw !== 'string' || !CANONICAL_UUID_SHAPE_REGEX.test(raw)) {
    return false;
  }
  return raw.charAt(14) === '7' && VALID_VARIANT_NIBBLES.has(raw.charAt(19));
}

export function extractUuidV7Timestamp(id: UuidV7): UnixMs {
  const canonical = parseUuidV7(id);
  const tsHex = canonical.slice(0, 8) + canonical.slice(9, 13);
  return unixMsFromBigInt(BigInt('0x' + tsHex));
}

export function uuidV7ToBytes(id: UuidV7): Uint8Array {
  const canonical = parseUuidV7(id);
  const hex =
    canonical.slice(0, 8) +
    canonical.slice(9, 13) +
    canonical.slice(14, 18) +
    canonical.slice(19, 23) +
    canonical.slice(24, 36);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const pos = i * 2;
    bytes[i] = (hexNibble(hex.charAt(pos)) << 4) | hexNibble(hex.charAt(pos + 1));
  }
  return bytes;
}

export function uuidV7FromBytes(bytes: Uint8Array): UuidV7 {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) {
    throw new DomainError('INVALID_UUID_FORMAT');
  }
  if ((bytes[6] & 0xf0) !== 0x70) {
    throw new DomainError('INVALID_UUID_VERSION');
  }
  if ((bytes[8] & 0xc0) !== 0x80) {
    throw new DomainError('INVALID_UUID_VARIANT');
  }
  const p1 = bytesToHex(bytes, 0, 4);
  const p2 = bytesToHex(bytes, 4, 6);
  const p3 = bytesToHex(bytes, 6, 8);
  const p4 = bytesToHex(bytes, 8, 10);
  const p5 = bytesToHex(bytes, 10, 16);
  return `${p1}-${p2}-${p3}-${p4}-${p5}` as UuidV7;
}

function seedCounterWithRolloverGuard(randomBytes: Uint8Array): number {
  // RFC 9562 Section 6.2 Method 1 + Counter Rollover Guard:
  // 24-bit counter initialized with 23 random bits (MSB 23 cleared to 0), guaranteeing >= 8,388,608 IDs/ms.
  return ((randomBytes[0] & 0x7f) << 16) | (randomBytes[1] << 8) | randomBytes[2];
}

function encodeMonotonicTail(counter: number, randomBytes: Uint8Array): Uint8Array {
  const tail = new Uint8Array(10);
  // rand_a (12 bits) = counter[23..12]
  tail[0] = 0x70 | ((counter >> 20) & 0x0f);
  tail[1] = (counter >> 12) & 0xff;
  // rand_b top 12 bits = counter[11..0], followed by 50 random bits
  tail[2] = 0x80 | ((counter >> 6) & 0x3f);
  tail[3] = ((counter & 0x3f) << 2) | (randomBytes[3] & 0x03);
  for (let i = 4; i < 10; i++) {
    tail[i] = randomBytes[i];
  }
  return tail;
}

/**
 * Pure monotonic state transition for RFC 9562 Section 6.2 Method 1 (24-bit counter + rollover guard).
 */
export function stepMonotonicUuidV7(
  prevState: MonotonicUuidV7State | null,
  clockMs: UnixMs,
  randomBytes: Uint8Array,
  initialLastMs?: UnixMs,
): MonotonicUuidV7StepResult {
  const currentMs = unixMsFromBigInt(clockMs) as bigint;
  assertValidRandomBytes(randomBytes);

  let nextTs: bigint;
  let nextCounter: number;

  if (prevState === null) {
    if (initialLastMs !== undefined) {
      const persistedMs = unixMsFromBigInt(initialLastMs) as bigint;
      if (currentMs > persistedMs) {
        nextTs = currentMs;
      } else {
        // After restart within the same millisecond or backward clock jump, the prior
        // process's 24-bit sub-ms counter is unknown, so advance by +1 ms to guarantee
        // strict monotonicity past any UUID generated before restart.
        nextTs = persistedMs + 1n;
        if (nextTs > MAX_UNIX_MS_RAW) {
          throw new DomainError('UUID_TIMESTAMP_OVERFLOW');
        }
      }
    } else {
      nextTs = currentMs;
    }
    nextCounter = seedCounterWithRolloverGuard(randomBytes);
  } else {
    const prevMs = unixMsFromBigInt(prevState.lastTimestampMs) as bigint;
    if (currentMs > prevMs) {
      nextTs = currentMs;
      nextCounter = seedCounterWithRolloverGuard(randomBytes);
    } else {
      nextCounter = prevState.counter + 1;
      if (nextCounter > MAX_UUID_V7_COUNTER) {
        nextTs = prevMs + 1n;
        if (nextTs > MAX_UNIX_MS_RAW) {
          throw new DomainError('UUID_TIMESTAMP_OVERFLOW');
        }
        nextCounter = seedCounterWithRolloverGuard(randomBytes);
      } else {
        nextTs = prevMs;
      }
    }
  }

  const tail = encodeMonotonicTail(nextCounter, randomBytes);
  const id = formatUuidFromTsAndTail(nextTs, tail);
  return {
    id,
    state: {
      lastTimestampMs: nextTs as UnixMs,
      counter: nextCounter,
    },
  };
}

/**
 * Monotonic RFC 9562 UUIDv7 generator using Section 6.2 Method 1 (24-bit dedicated counter
 * in `rand_a` + top 12 bits of `rand_b`, MSB rollover guard, and 50 fresh random bits per ID).
 *
 * NOTE (Clock forward jump behavior): If the physical clock jumps into the future (e.g. year 2030)
 * once and subsequently returns to real time, Method 1 pins all subsequent generated UUIDv7
 * timestamps to that high-water timestamp to preserve strict ID monotonicity. Therefore UUIDv7
 * timestamps MUST NOT be treated as authoritative business or event ordering time — that role
 * belongs exclusively to HLC (`HlcClock`), which enforces `MAX_SKEW` clamping.
 */
export class MonotonicUuidV7Generator implements IdGenerator {
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly initialLastMs?: UnixMs;
  private state: MonotonicUuidV7State | null = null;

  constructor(options: MonotonicUuidV7GeneratorOptions) {
    this.clock = options.clock;
    this.random = options.random;
    if (options.initialLastMs !== undefined) {
      this.initialLastMs = unixMsFromBigInt(options.initialLastMs);
    }
  }

  nextId(): UuidV7 {
    const clockMs = unixMsFromBigInt(this.clock.now());
    const randomBytes = this.random.nextBytes(UUID_V7_RANDOM_BYTES_LENGTH);
    const result = stepMonotonicUuidV7(this.state, clockMs, randomBytes, this.initialLastMs);
    this.state = result.state;
    return result.id;
  }

  currentLastTimestampMs(): UnixMs | null {
    return this.state !== null ? this.state.lastTimestampMs : (this.initialLastMs ?? null);
  }
}
