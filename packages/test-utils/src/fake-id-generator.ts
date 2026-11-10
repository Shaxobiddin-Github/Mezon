import {
  type IdGenerator,
  type UnixMs,
  type UuidV7,
  addUnixMs,
  encodeUuidV7,
  parseUuidV7,
  unixMsFromBigInt,
} from '@mezon/domain';

export interface DeterministicUuidV7GeneratorOptions {
  readonly timestampMs?: UnixMs | bigint;
  readonly startCounter?: bigint;
}

/**
 * Predictable, strictly monotonic UUIDv7 generator for unit and integration tests.
 * Produces human-readable IDs (e.g. `...-7000-8000-000000000001`).
 */
export class DeterministicUuidV7Generator implements IdGenerator {
  private timestampMs: UnixMs;
  private counter: bigint;

  constructor(options: DeterministicUuidV7GeneratorOptions = {}) {
    this.timestampMs = unixMsFromBigInt(options.timestampMs ?? 1_700_000_000_000n);
    this.counter = options.startCounter ?? 1n;
    if (this.counter < 0n) {
      throw new RangeError('startCounter must be non-negative');
    }
  }

  nextId(): UuidV7 {
    const MAX_LOW_COUNTER = 0xffffffffffffn;
    if (this.counter > MAX_LOW_COUNTER) {
      this.timestampMs = addUnixMs(this.timestampMs, 1n);
      this.counter = 0n;
    }

    const bytes = new Uint8Array(10);
    let val = this.counter;
    for (let i = 9; i >= 4; i--) {
      bytes[i] = Number(val & 0xffn);
      val >>= 8n;
    }
    this.counter += 1n;
    return encodeUuidV7(this.timestampMs, bytes);
  }
}

export class FixedIdGenerator implements IdGenerator {
  private readonly ids: UuidV7[];
  private index = 0;

  constructor(ids: UuidV7 | readonly UuidV7[]) {
    const list = typeof ids === 'string' ? [ids] : ids;
    if (list.length === 0) {
      throw new RangeError('FixedIdGenerator requires at least one UUIDv7');
    }
    this.ids = list.map((id) => parseUuidV7(id));
  }

  nextId(): UuidV7 {
    const id = this.ids[this.index];
    if (this.index < this.ids.length - 1) {
      this.index += 1;
    }
    return id;
  }
}
