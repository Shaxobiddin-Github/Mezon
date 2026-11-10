import { describe, expect, it } from 'vitest';
import {
  extractUuidV7Timestamp,
  isValidUuidV7,
  unixMsFromBigInt,
  unixMsToBigInt,
} from '@mezon/domain';
import {
  CryptoRandomSource,
  DRIVERS_PACKAGE,
  SystemClock,
  createSystemUuidV7Generator,
} from './index.js';

describe('@mezon/drivers - Runtime Clock, RandomSource, and UUIDv7 adapters', () => {
  it('exports package marker', () => {
    expect(DRIVERS_PACKAGE).toBe('@mezon/drivers');
  });

  it('SystemClock reads current Date.now() within valid UnixMs range', () => {
    const clock = new SystemClock();
    const before = BigInt(Date.now());
    const now = unixMsToBigInt(clock.now());
    const after = BigInt(Date.now());

    expect(now >= before).toBe(true);
    expect(now <= after).toBe(true);
  });

  it('CryptoRandomSource generates random bytes across small and >64KiB requests', () => {
    const rng = new CryptoRandomSource();
    expect(rng.nextBytes(0).length).toBe(0);

    const a = rng.nextBytes(32);
    const b = rng.nextBytes(32);
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(a.some((byte, idx) => byte !== b[idx])).toBe(true);

    // Chunking > 65536 bytes limit of Web Crypto getRandomValues
    const large = rng.nextBytes(70_000);
    expect(large.length).toBe(70_000);

    expect(() => rng.nextBytes(-1)).toThrow(RangeError);
    expect(() => rng.nextBytes(1.5)).toThrow(RangeError);
  });

  it('createSystemUuidV7Generator creates valid strictly monotonic UUIDv7 IDs', () => {
    const gen = createSystemUuidV7Generator();
    let prev = gen.nextId();
    expect(isValidUuidV7(prev)).toBe(true);

    for (let i = 0; i < 1000; i++) {
      const curr = gen.nextId();
      expect(isValidUuidV7(curr)).toBe(true);
      expect(curr > prev).toBe(true);
      prev = curr;
    }

    // With initialLastMs far ahead (clock appears behind initialLastMs)
    const futureInitial = unixMsFromBigInt(BigInt(Date.now()) + 10_000n);
    const recoveredGen = createSystemUuidV7Generator(futureInitial);
    const recoveredId = recoveredGen.nextId();
    expect(isValidUuidV7(recoveredId)).toBe(true);
    expect(unixMsToBigInt(extractUuidV7Timestamp(recoveredId))).toBe(
      unixMsToBigInt(futureInitial) + 1n,
    );
  });
});
