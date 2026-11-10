import { type Clock, type UnixMs, addUnixMs, unixMsFromBigInt } from '@mezon/domain';

export class FixedClock implements Clock {
  private current: UnixMs;

  constructor(initialMs: UnixMs | bigint = 1_700_000_000_000n) {
    this.current = unixMsFromBigInt(initialMs);
  }

  now(): UnixMs {
    return this.current;
  }

  set(ms: UnixMs | bigint): void {
    this.current = unixMsFromBigInt(ms);
  }

  advance(deltaMs: bigint): UnixMs {
    this.current = addUnixMs(this.current, deltaMs);
    return this.current;
  }
}

export class SequenceClock implements Clock {
  private readonly values: UnixMs[];
  private index = 0;

  constructor(values: readonly (UnixMs | bigint)[]) {
    if (values.length === 0) {
      throw new RangeError('SequenceClock requires at least one timestamp');
    }
    this.values = values.map((v) => unixMsFromBigInt(v));
  }

  now(): UnixMs {
    const idx = this.index < this.values.length ? this.index : this.values.length - 1;
    if (this.index < this.values.length - 1) {
      this.index += 1;
    }
    return this.values[idx];
  }
}
