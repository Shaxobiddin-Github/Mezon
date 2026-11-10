import { describe, expect, it } from 'vitest';
import {
  DomainError,
  HlcClock,
  MAX_UNIX_MS,
  MonotonicUuidV7Generator,
  isValidUuidV7,
  parseUuidV7,
  unixMsFromBigInt,
  unixMsToBigInt,
} from '@mezon/domain';
import {
  DeterministicUuidV7Generator,
  FixedClock,
  FixedIdGenerator,
  FixedRandomSource,
  SeededRandomSource,
  SequenceClock,
  SequenceRandomSource,
  TEST_UTILS_PACKAGE,
} from './index.js';

describe('@mezon/test-utils - Deterministic Clock, RandomSource, and IdGenerator adapters', () => {
  it('exports package marker', () => {
    expect(TEST_UTILS_PACKAGE).toBe('@mezon/test-utils');
  });

  it('FixedClock supports set, advance, and backward time shifts with range check', () => {
    const clock = new FixedClock(1000n);
    expect(unixMsToBigInt(clock.now())).toBe(1000n);

    clock.advance(500n);
    expect(unixMsToBigInt(clock.now())).toBe(1500n);

    clock.advance(-1000n);
    expect(unixMsToBigInt(clock.now())).toBe(500n);

    clock.set(0n);
    expect(unixMsToBigInt(clock.now())).toBe(0n);

    expect(() => clock.advance(-1n)).toThrowError(DomainError);
    expect(() => clock.set(unixMsToBigInt(MAX_UNIX_MS) + 1n)).toThrowError(DomainError);
  });

  it('SequenceClock yields values in sequence and holds the last timestamp', () => {
    expect(() => new SequenceClock([])).toThrow(RangeError);
    const seq = new SequenceClock([1000n, 2000n, 1500n]);
    expect(unixMsToBigInt(seq.now())).toBe(1000n);
    expect(unixMsToBigInt(seq.now())).toBe(2000n);
    expect(unixMsToBigInt(seq.now())).toBe(1500n);
    expect(unixMsToBigInt(seq.now())).toBe(1500n);
  });

  it('FixedRandomSource, SequenceRandomSource, and SeededRandomSource behave deterministically', () => {
    const fixedFill = new FixedRandomSource(0xab);
    expect(fixedFill.nextBytes(4)).toEqual(new Uint8Array([0xab, 0xab, 0xab, 0xab]));

    const fixedPattern = new FixedRandomSource(new Uint8Array([1, 2, 3]));
    expect(fixedPattern.nextBytes(5)).toEqual(new Uint8Array([1, 2, 3, 1, 2]));

    expect(() => new FixedRandomSource(-1)).toThrow(RangeError);
    expect(() => new FixedRandomSource(256)).toThrow(RangeError);
    expect(() => new FixedRandomSource(new Uint8Array(0))).toThrow(RangeError);

    expect(() => new SequenceRandomSource([])).toThrow(RangeError);
    const seqRng = new SequenceRandomSource([new Uint8Array([10, 20]), new Uint8Array([30, 40])]);
    expect(seqRng.nextBytes(2)).toEqual(new Uint8Array([10, 20]));
    expect(seqRng.nextBytes(2)).toEqual(new Uint8Array([30, 40]));
    expect(seqRng.nextBytes(2)).toEqual(new Uint8Array([30, 40]));
    expect(() => seqRng.nextBytes(3)).toThrow(RangeError);

    const rng1 = new SeededRandomSource(42);
    const rng2 = new SeededRandomSource(42);
    const rng3 = new SeededRandomSource(99);
    expect(rng1.nextBytes(16)).toEqual(rng2.nextBytes(16));
    expect(rng1.nextBytes(16)).not.toEqual(rng3.nextBytes(16));
  });

  it('DeterministicUuidV7Generator and FixedIdGenerator produce valid monotonic UUIDv7s', () => {
    const idGen = new DeterministicUuidV7Generator();
    const id1 = idGen.nextId();
    const id2 = idGen.nextId();
    expect(isValidUuidV7(id1)).toBe(true);
    expect(isValidUuidV7(id2)).toBe(true);
    expect(id2 > id1).toBe(true);

    // Overflow of low 48-bit counter advances timestampMs cleanly
    const rolloverGen = new DeterministicUuidV7Generator({
      timestampMs: unixMsFromBigInt(5000n),
      startCounter: 0xffffffffffffn,
    });
    const atMaxCounter = rolloverGen.nextId();
    const wrapped = rolloverGen.nextId();
    expect(isValidUuidV7(atMaxCounter)).toBe(true);
    expect(isValidUuidV7(wrapped)).toBe(true);
    expect(wrapped > atMaxCounter).toBe(true);

    const u1 = parseUuidV7('017f22e2-79b0-7cc3-98c4-dc0c0c07398f');
    const u2 = parseUuidV7('017f22e2-79b0-7cc3-98c4-dc0c0c073990');
    const fixedGen = new FixedIdGenerator([u1, u2]);
    expect(fixedGen.nextId()).toBe(u1);
    expect(fixedGen.nextId()).toBe(u2);
    expect(fixedGen.nextId()).toBe(u2);

    expect(() => new FixedIdGenerator([])).toThrow(RangeError);
  });

  it('integrates deterministic Clock/RandomSource cleanly with domain MonotonicUuidV7Generator and HlcClock', () => {
    const clock = new SequenceClock([2000n, 1500n, 2001n]);
    const rng = new SeededRandomSource(123);
    const uuidGen = new MonotonicUuidV7Generator({ clock, random: rng });

    const a = uuidGen.nextId();
    const b = uuidGen.nextId();
    const c = uuidGen.nextId();
    expect(b > a).toBe(true);
    expect(c > b).toBe(true);

    const hlcClock = new HlcClock({
      clock: new FixedClock(5000n),
      nodeId: new DeterministicUuidV7Generator().nextId(),
    });
    expect(hlcClock.now().hlc.logical).toBe(0);
    expect(hlcClock.now().hlc.logical).toBe(1);
  });
});
