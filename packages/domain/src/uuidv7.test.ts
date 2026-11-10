import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  type Clock,
  DomainError,
  type DomainErrorCode,
  MAX_UNIX_MS,
  MAX_UUID_V7_COUNTER,
  MIN_UNIX_MS,
  MonotonicUuidV7Generator,
  type RandomSource,
  UUID_V7_RANDOM_BYTES_LENGTH,
  type UnixMs,
  type UuidV7,
  encodeUuidV7,
  extractUuidV7Timestamp,
  isValidUuidV7,
  parseUuidV7,
  stepMonotonicUuidV7,
  unixMsFromBigInt,
  unixMsToBigInt,
  uuidV7FromBytes,
  uuidV7ToBytes,
} from './index.js';

function expectDomainError(fn: () => unknown, expectedCode: DomainErrorCode): void {
  try {
    fn();
    expect.unreachable('Expected DomainError to be thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(expectedCode);
  }
}

class LocalFakeClock implements Clock {
  constructor(public current: UnixMs) {}
  now(): UnixMs {
    return this.current;
  }
}

class LocalPatternRandom implements RandomSource {
  constructor(private bytes: Uint8Array) {}
  setBytes(bytes: Uint8Array): void {
    this.bytes = bytes;
  }
  nextBytes(length: number): Uint8Array {
    if (length === this.bytes.length) {
      return Uint8Array.from(this.bytes);
    }
    return Uint8Array.from(this.bytes.slice(0, length));
  }
}

describe('@mezon/domain - UUIDv7 (RFC 9562)', () => {
  it('matches the official RFC 9562 Appendix A.6 test vector bit-for-bit', () => {
    // RFC 9562 Section A.6 Figure 26:
    // unix_ts_ms = 0x017F22E279B0 (1645557742000n)
    // ver        = 0x7
    // rand_a     = 0xCC3
    // var        = 0b10
    // rand_b     = 0b01, 0x8C4DC0C0C07398F
    // canonical  = 017f22e2-79b0-7cc3-98c4-dc0c0c07398f
    const rfcVector = '017f22e2-79b0-7cc3-98c4-dc0c0c07398f';
    const ts = unixMsFromBigInt(0x017f22e279b0n);
    expect(unixMsToBigInt(ts)).toBe(1_645_557_742_000n);

    const randomBytes = new Uint8Array([
      0x0c, 0xc3, 0x18, 0xc4, 0xdc, 0x0c, 0x0c, 0x07, 0x39, 0x8f,
    ]);
    const encoded = encodeUuidV7(ts, randomBytes);
    expect(encoded).toBe(rfcVector);

    // Dirty version/variant top bits in randomBytes must still be masked strictly to ver=7, var=10
    const dirtyBytes = new Uint8Array([0xfc, 0xc3, 0xd8, 0xc4, 0xdc, 0x0c, 0x0c, 0x07, 0x39, 0x8f]);
    expect(encodeUuidV7(ts, dirtyBytes)).toBe(rfcVector);

    const parsed = parseUuidV7(rfcVector);
    expect(parsed).toBe(rfcVector);
    expect(isValidUuidV7(rfcVector)).toBe(true);
    expect(unixMsToBigInt(extractUuidV7Timestamp(parsed))).toBe(1_645_557_742_000n);

    const expected16Bytes = new Uint8Array([
      0x01, 0x7f, 0x22, 0xe2, 0x79, 0xb0, 0x7c, 0xc3, 0x98, 0xc4, 0xdc, 0x0c, 0x0c, 0x07, 0x39,
      0x8f,
    ]);
    const decodedBytes = uuidV7ToBytes(parsed);
    expect(decodedBytes).toEqual(expected16Bytes);
    expect(uuidV7FromBytes(expected16Bytes)).toBe(rfcVector);

    // Covers '0', '9', 'a', 'f' ASCII boundaries in hexNibble/bytesToHex
    const boundaryUuid = parseUuidV7('09af09af-09af-709a-a9af-0123456789af');
    expect(uuidV7FromBytes(uuidV7ToBytes(boundaryUuid))).toBe(boundaryUuid);
    expectDomainError(() => uuidV7ToBytes('BAD' as UuidV7), 'INVALID_UUID_FORMAT');
    expectDomainError(() => extractUuidV7Timestamp('BAD' as UuidV7), 'INVALID_UUID_FORMAT');
  });

  it('encodes MIN_UNIX_MS and MAX_UNIX_MS boundaries cleanly', () => {
    const zeroBytes = new Uint8Array(UUID_V7_RANDOM_BYTES_LENGTH);
    const minUuid = encodeUuidV7(MIN_UNIX_MS, zeroBytes);
    expect(minUuid).toBe('00000000-0000-7000-8000-000000000000');
    expect(unixMsToBigInt(extractUuidV7Timestamp(minUuid))).toBe(0n);

    const allOnes = new Uint8Array(UUID_V7_RANDOM_BYTES_LENGTH).fill(0xff);
    const maxUuid = encodeUuidV7(MAX_UNIX_MS, allOnes);
    expect(maxUuid).toBe('ffffffff-ffff-7fff-bfff-ffffffffffff');
    expect(unixMsToBigInt(extractUuidV7Timestamp(maxUuid))).toBe(unixMsToBigInt(MAX_UNIX_MS));
  });

  it('rejects invalid inputs, uppercase strings, wrong versions, and wrong variants with exact error codes', () => {
    // encodeUuidV7 validation
    expectDomainError(() => encodeUuidV7(-1n as UnixMs, new Uint8Array(10)), 'INVALID_TIMESTAMP');
    expectDomainError(
      () => encodeUuidV7((unixMsToBigInt(MAX_UNIX_MS) + 1n) as UnixMs, new Uint8Array(10)),
      'INVALID_TIMESTAMP',
    );
    expectDomainError(() => encodeUuidV7(MIN_UNIX_MS, new Uint8Array(9)), 'INVALID_RANDOM_BYTES');
    expectDomainError(() => encodeUuidV7(MIN_UNIX_MS, new Uint8Array(11)), 'INVALID_RANDOM_BYTES');
    expectDomainError(
      () => encodeUuidV7(MIN_UNIX_MS, null as unknown as Uint8Array),
      'INVALID_RANDOM_BYTES',
    );

    // Format violations -> INVALID_UUID_FORMAT
    const badFormats = [
      '',
      '017F22E2-79B0-7CC3-98C4-DC0C0C07398F', // uppercase rejected (canonical lowercase only)
      '017f22e279b07cc398c4dc0c0c07398f', // missing hyphens
      '017f22e2-79b0-7cc3-98c4-dc0c0c07398', // too short
      '017f22e2-79b0-7cc3-98c4-dc0c0c07398ff', // too long
      '017f22e2-79b0-7cc3-98c4-dc0c0c07398g', // non-hex
      ' 017f22e2-79b0-7cc3-98c4-dc0c0c07398f', // leading space
      '017f22e2-79b07-cc3-98c4-dc0c0c07398f', // wrong hyphen pos
    ];
    for (const bad of badFormats) {
      expect(isValidUuidV7(bad)).toBe(false);
      expectDomainError(() => parseUuidV7(bad), 'INVALID_UUID_FORMAT');
    }
    expectDomainError(() => parseUuidV7(123 as unknown as string), 'INVALID_UUID_FORMAT');

    // Wrong version -> INVALID_UUID_VERSION
    for (const ver of ['0', '1', '3', '4', '5', '6', '8', 'f']) {
      const badVer = `017f22e2-79b0-${ver}cc3-98c4-dc0c0c07398f`;
      expect(isValidUuidV7(badVer)).toBe(false);
      expectDomainError(() => parseUuidV7(badVer), 'INVALID_UUID_VERSION');
    }

    // Valid variants are ONLY 8, 9, a, b (0b10xx)
    for (const goodVar of ['8', '9', 'a', 'b']) {
      const ok = `017f22e2-79b0-7cc3-${goodVar}8c4-dc0c0c07398f`;
      expect(isValidUuidV7(ok)).toBe(true);
      expect(parseUuidV7(ok)).toBe(ok);
    }

    // Wrong variants -> INVALID_UUID_VARIANT
    for (const badVar of ['0', '1', '2', '3', '4', '5', '6', '7', 'c', 'd', 'e', 'f']) {
      const bad = `017f22e2-79b0-7cc3-${badVar}8c4-dc0c0c07398f`;
      expect(isValidUuidV7(bad)).toBe(false);
      expectDomainError(() => parseUuidV7(bad), 'INVALID_UUID_VARIANT');
    }

    // Bytes validation
    expectDomainError(() => uuidV7FromBytes(new Uint8Array(15)), 'INVALID_UUID_FORMAT');
    expectDomainError(() => uuidV7FromBytes(new Uint8Array(17)), 'INVALID_UUID_FORMAT');
    const badVerBytes = uuidV7ToBytes(parseUuidV7('017f22e2-79b0-7cc3-98c4-dc0c0c07398f'));
    badVerBytes[6] = 0x4c;
    expectDomainError(() => uuidV7FromBytes(badVerBytes), 'INVALID_UUID_VERSION');

    const badVarBytes = uuidV7ToBytes(parseUuidV7('017f22e2-79b0-7cc3-98c4-dc0c0c07398f'));
    badVarBytes[8] = 0xc8;
    expectDomainError(() => uuidV7FromBytes(badVarBytes), 'INVALID_UUID_VARIANT');
    badVarBytes[8] = 0x78;
    expectDomainError(() => uuidV7FromBytes(badVarBytes), 'INVALID_UUID_VARIANT');
  });

  it('enforces Method 1 24-bit counter with MSB rollover guard and strict monotonicity in same ms', () => {
    const clock = new LocalFakeClock(unixMsFromBigInt(1_700_000_000_000n));
    const random = new LocalPatternRandom(new Uint8Array(10).fill(0xff));
    const gen = new MonotonicUuidV7Generator({ clock, random });

    const first = gen.nextId();
    // MSB 23 must be cleared by rollover guard even when random bytes are 0xff:
    // counter seed = 0x7fffff -> tail[0] = 0x77, tail[1] = 0xff, tail[2] = 0xbf, tail[3] = 0xff
    expect(first.slice(14, 18)).toBe('77ff');
    expect(first.slice(19, 23)).toBe('bfff');

    // Flip trailing random bytes to 0x00 on second call in same ms -> counter increments to 0x800000,
    // which MUST still be strictly greater than `first` even though random suffix dropped to 0x00.
    random.setBytes(new Uint8Array(10).fill(0x00));
    const second = gen.nextId();
    expect(second.slice(14, 18)).toBe('7800');
    expect(second.slice(19, 23)).toBe('8000');
    expect(second > first).toBe(true);

    // 5,000 IDs generated within identical ms remain strictly increasing without advancing timestamp
    let prev = second;
    for (let i = 0; i < 5000; i++) {
      random.setBytes(new Uint8Array(10).fill(i % 2 === 0 ? 0xff : 0x00));
      const curr = gen.nextId();
      expect(curr > prev).toBe(true);
      expect(unixMsToBigInt(extractUuidV7Timestamp(curr))).toBe(1_700_000_000_000n);
      prev = curr;
    }
  });

  it('remains strictly monotonic when physical clock rolls back or jumps forward and returns', () => {
    const clock = new LocalFakeClock(unixMsFromBigInt(2000n));
    const random = new LocalPatternRandom(
      new Uint8Array([0x12, 0x34, 0x56, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x11, 0x22]),
    );
    const gen = new MonotonicUuidV7Generator({ clock, random });

    const id1 = gen.nextId();
    expect(unixMsToBigInt(extractUuidV7Timestamp(id1))).toBe(2000n);

    // Backward jump to 1500n -> pins to 2000n and increments counter
    clock.current = unixMsFromBigInt(1500n);
    const id2 = gen.nextId();
    expect(unixMsToBigInt(extractUuidV7Timestamp(id2))).toBe(2000n);
    expect(id2 > id1).toBe(true);

    // Partial recovery still below 2000n
    clock.current = unixMsFromBigInt(1999n);
    const id3 = gen.nextId();
    expect(unixMsToBigInt(extractUuidV7Timestamp(id3))).toBe(2000n);
    expect(id3 > id2).toBe(true);

    // Catch up to 2000n -> still monotonic increment
    clock.current = unixMsFromBigInt(2000n);
    const id4 = gen.nextId();
    expect(unixMsToBigInt(extractUuidV7Timestamp(id4))).toBe(2000n);
    expect(id4 > id3).toBe(true);

    // Advance past 2000n -> re-seeds cleanly at 2001n
    clock.current = unixMsFromBigInt(2001n);
    const id5 = gen.nextId();
    expect(unixMsToBigInt(extractUuidV7Timestamp(id5))).toBe(2001n);
    expect(id5 > id4).toBe(true);

    // Temporary jump into future (e.g. year 2030) pins subsequent IDs to that high-water mark (documented behavior)
    clock.current = unixMsFromBigInt(1_900_000_000_000n);
    const futureId = gen.nextId();
    expect(unixMsToBigInt(extractUuidV7Timestamp(futureId))).toBe(1_900_000_000_000n);
    clock.current = unixMsFromBigInt(2005n);
    const afterJumpBack = gen.nextId();
    expect(unixMsToBigInt(extractUuidV7Timestamp(afterJumpBack))).toBe(1_900_000_000_000n);
    expect(afterJumpBack > futureId).toBe(true);
  });

  it('handles 24-bit counter rollover and MAX_UNIX_MS overflow without state corruption', () => {
    const bytes = new Uint8Array(10).fill(0x55);
    const atMaxCounter = stepMonotonicUuidV7(
      { lastTimestampMs: unixMsFromBigInt(1000n), counter: MAX_UUID_V7_COUNTER - 1 },
      unixMsFromBigInt(1000n),
      bytes,
    );
    expect(atMaxCounter.state.counter).toBe(MAX_UUID_V7_COUNTER);
    expect(unixMsToBigInt(atMaxCounter.state.lastTimestampMs)).toBe(1000n);

    // Next step overflows 24-bit counter -> advances timestamp by +1ms and re-seeds counter
    const rolledOver = stepMonotonicUuidV7(atMaxCounter.state, unixMsFromBigInt(1000n), bytes);
    expect(unixMsToBigInt(rolledOver.state.lastTimestampMs)).toBe(1001n);
    expect(rolledOver.state.counter).toBe(((0x55 & 0x7f) << 16) | (0x55 << 8) | 0x55);
    expect(rolledOver.id > atMaxCounter.id).toBe(true);

    // Exact bit layout check: counter = 0x102041 -> c23..20=1, c19..12=02, c11..6=01, c5..0=01, bytes[3]&3=3
    const bitStep = stepMonotonicUuidV7(
      { lastTimestampMs: unixMsFromBigInt(1000n), counter: 0x102040 },
      unixMsFromBigInt(1000n),
      new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0]),
    );
    // tail[0]=0x71, tail[1]=0x02, tail[2]=0x81, tail[3]=(0x01<<2)|0x03=0x07
    expect(bitStep.id.slice(14, 23)).toBe('7102-8107');

    // Advancing clock ms re-seeds counter from bytes cleanly instead of keeping old counter
    const advancedMs = stepMonotonicUuidV7(atMaxCounter.state, unixMsFromBigInt(1005n), bytes);
    expect(unixMsToBigInt(advancedMs.state.lastTimestampMs)).toBe(1005n);
    expect(advancedMs.state.counter).toBe(((0x55 & 0x7f) << 16) | (0x55 << 8) | 0x55);

    // At MAX_UNIX_MS with MAX_UUID_V7_COUNTER -> throws UUID_TIMESTAMP_OVERFLOW
    expectDomainError(
      () =>
        stepMonotonicUuidV7(
          { lastTimestampMs: MAX_UNIX_MS, counter: MAX_UUID_V7_COUNTER },
          MAX_UNIX_MS,
          bytes,
        ),
      'UUID_TIMESTAMP_OVERFLOW',
    );
  });

  it('guarantees strict monotonicity across process restarts via initialLastMs', () => {
    const persistedMs = unixMsFromBigInt(5000n);
    // Worst-case pre-crash UUID generated at persistedMs (all random/counter bits set to 1)
    const maxPreCrashUuid = encodeUuidV7(persistedMs, new Uint8Array(10).fill(0xff));

    // Restart with clock rolled back below persistedMs -> advances past persistedMs
    const clockRollback = new LocalFakeClock(unixMsFromBigInt(4000n));
    const genAfterRollback = new MonotonicUuidV7Generator({
      clock: clockRollback,
      random: new LocalPatternRandom(new Uint8Array(10).fill(0x00)),
      initialLastMs: persistedMs,
    });
    expect(unixMsToBigInt(genAfterRollback.currentLastTimestampMs()!)).toBe(5000n);

    const postRestart1 = genAfterRollback.nextId();
    expect(unixMsToBigInt(extractUuidV7Timestamp(postRestart1))).toBe(5001n);
    expect(postRestart1 > maxPreCrashUuid).toBe(true);

    // Restart in exact same millisecond as persistedMs -> advances to persistedMs + 1
    const clockSameMs = new LocalFakeClock(persistedMs);
    const genSameMs = new MonotonicUuidV7Generator({
      clock: clockSameMs,
      random: new LocalPatternRandom(new Uint8Array(10).fill(0x00)),
      initialLastMs: persistedMs,
    });
    const postRestartSameMs = genSameMs.nextId();
    expect(unixMsToBigInt(extractUuidV7Timestamp(postRestartSameMs))).toBe(5001n);
    expect(postRestartSameMs > maxPreCrashUuid).toBe(true);

    // Restart after clock moved forward -> no millisecond skipped
    const clockForward = new LocalFakeClock(unixMsFromBigInt(5002n));
    const genForward = new MonotonicUuidV7Generator({
      clock: clockForward,
      random: new LocalPatternRandom(new Uint8Array(10).fill(0x00)),
      initialLastMs: persistedMs,
    });
    const postRestartForward = genForward.nextId();
    expect(unixMsToBigInt(extractUuidV7Timestamp(postRestartForward))).toBe(5002n);
    expect(postRestartForward > maxPreCrashUuid).toBe(true);

    // initialLastMs === MAX_UNIX_MS when clock <= MAX_UNIX_MS -> UUID_TIMESTAMP_OVERFLOW without corrupting state
    const genAtMax = new MonotonicUuidV7Generator({
      clock: new LocalFakeClock(MAX_UNIX_MS),
      random: new LocalPatternRandom(new Uint8Array(10).fill(0x00)),
      initialLastMs: MAX_UNIX_MS,
    });
    expectDomainError(() => genAtMax.nextId(), 'UUID_TIMESTAMP_OVERFLOW');
    expect(unixMsToBigInt(genAtMax.currentLastTimestampMs()!)).toBe(unixMsToBigInt(MAX_UNIX_MS));
  });

  it('rejects bad RandomSource lengths atomically without mutating state', () => {
    const clock = new LocalFakeClock(unixMsFromBigInt(1000n));
    const random = new LocalPatternRandom(new Uint8Array(10).fill(0x11));
    const gen = new MonotonicUuidV7Generator({ clock, random });

    const id1 = gen.nextId();
    random.setBytes(new Uint8Array(9)); // invalid length
    expectDomainError(() => gen.nextId(), 'INVALID_RANDOM_BYTES');

    // Recover after restoring valid RandomSource: sequence continues cleanly
    random.setBytes(new Uint8Array(10).fill(0x22));
    const id2 = gen.nextId();
    expect(id2 > id1).toBe(true);
  });

  it('verifies strict monotonicity and round-trip invariants with fast-check', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            deltaMs: fc.bigInt({ min: -500n, max: 500n }),
            bytes: fc.uint8Array({ minLength: 10, maxLength: 10 }),
          }),
          { minLength: 2, maxLength: 30 },
        ),
        (steps) => {
          let currentClock = 1_700_000_000_000n;
          const clock = new LocalFakeClock(unixMsFromBigInt(currentClock));
          const random = new LocalPatternRandom(steps[0].bytes);
          const gen = new MonotonicUuidV7Generator({ clock, random });

          let prevId: UuidV7 | null = null;
          for (const step of steps) {
            const nextClock = currentClock + step.deltaMs;
            currentClock = nextClock >= 0n ? nextClock : 0n;
            clock.current = unixMsFromBigInt(currentClock);
            random.setBytes(step.bytes);

            const id = gen.nextId();
            expect(isValidUuidV7(id)).toBe(true);
            expect(uuidV7FromBytes(uuidV7ToBytes(id))).toBe(id);
            if (prevId !== null) {
              expect(id > prevId).toBe(true);
            }
            prevId = id;
          }
        },
      ),
    );
  });
});
