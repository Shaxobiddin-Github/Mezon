import { type RandomSource } from '@mezon/domain';

function assertLength(length: number): void {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError('Random byte length must be a non-negative integer');
  }
}

export class FixedRandomSource implements RandomSource {
  private readonly pattern: Uint8Array;

  constructor(fill: Uint8Array | number = 0) {
    if (typeof fill === 'number') {
      if (!Number.isInteger(fill) || fill < 0 || fill > 255) {
        throw new RangeError('Fill byte must be an integer in [0, 255]');
      }
      this.pattern = new Uint8Array([fill]);
    } else {
      if (fill.length === 0) {
        throw new RangeError('FixedRandomSource pattern must not be empty');
      }
      this.pattern = Uint8Array.from(fill);
    }
  }

  nextBytes(length: number): Uint8Array {
    assertLength(length);
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = this.pattern[i % this.pattern.length];
    }
    return out;
  }
}

export class SequenceRandomSource implements RandomSource {
  private readonly chunks: Uint8Array[];
  private index = 0;

  constructor(chunks: readonly Uint8Array[]) {
    if (chunks.length === 0) {
      throw new RangeError('SequenceRandomSource requires at least one byte array');
    }
    this.chunks = chunks.map((c) => Uint8Array.from(c));
  }

  nextBytes(length: number): Uint8Array {
    assertLength(length);
    const chunk = this.chunks[this.index];
    if (this.index < this.chunks.length - 1) {
      this.index += 1;
    }
    if (chunk.length < length) {
      throw new RangeError(
        `SequenceRandomSource chunk length ${chunk.length} is smaller than requested ${length}`,
      );
    }
    return Uint8Array.from(chunk.subarray(0, length));
  }
}

/**
 * Deterministic SplitMix32 PRNG for reproducible tests. NOT cryptographically secure.
 */
export class SeededRandomSource implements RandomSource {
  private state: number;

  constructor(seed: number = 0x12345678) {
    this.state = seed | 0;
  }

  nextBytes(length: number): Uint8Array {
    assertLength(length);
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      this.state = (this.state + 0x9e3779b9) | 0;
      let z = this.state;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      z = z ^ (z >>> 16);
      out[i] = z & 0xff;
    }
    return out;
  }
}
