import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DomainError,
  type DomainErrorCode,
  MAX_UNIX_MS,
  MIN_UNIX_MS,
  type Money,
  type Quantity,
  type UnixMs,
  type UuidV7,
  addUnixMs,
  diffUnixMs,
  moneyFromTiyin,
  parseUnixMs,
  quantityFromMilli,
  serializeUnixMs,
  unixMsFromBigInt,
  unixMsToBigInt,
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

describe('@mezon/domain - UnixMs and Clock ports', () => {
  it('validates 48-bit unsigned UnixMs boundaries', () => {
    expect(unixMsToBigInt(MIN_UNIX_MS)).toBe(0n);
    expect(unixMsToBigInt(MAX_UNIX_MS)).toBe(281_474_976_710_655n);
    expect(unixMsToBigInt(unixMsFromBigInt(0n))).toBe(0n);
    expect(unixMsToBigInt(unixMsFromBigInt(281_474_976_710_655n))).toBe(281_474_976_710_655n);

    expectDomainError(() => unixMsFromBigInt(-1n), 'INVALID_TIMESTAMP');
    expectDomainError(() => unixMsFromBigInt(281_474_976_710_656n), 'INVALID_TIMESTAMP');
    expectDomainError(() => unixMsFromBigInt('1000' as unknown as bigint), 'INVALID_TIMESTAMP');
  });

  it('adds and diffs UnixMs with range enforcement', () => {
    const t0 = unixMsFromBigInt(1_700_000_000_000n);
    const t1 = addUnixMs(t0, 5_000n);
    expect(unixMsToBigInt(t1)).toBe(1_700_000_005_000n);
    expect(unixMsToBigInt(addUnixMs(t1, -5_000n))).toBe(1_700_000_000_000n);
    expect(diffUnixMs(t1, t0)).toBe(5_000n);
    expect(diffUnixMs(t0, t1)).toBe(-5_000n);

    expectDomainError(() => addUnixMs(MIN_UNIX_MS, -1n), 'INVALID_TIMESTAMP');
    expectDomainError(() => addUnixMs(MAX_UNIX_MS, 1n), 'INVALID_TIMESTAMP');
    expectDomainError(() => addUnixMs(t0, 1.5 as unknown as bigint), 'INVALID_TIMESTAMP');
    expectDomainError(() => diffUnixMs(-1n as UnixMs, t0), 'INVALID_TIMESTAMP');
    expectDomainError(() => diffUnixMs(t0, (MAX_UNIX_MS + 1n) as UnixMs), 'INVALID_TIMESTAMP');
  });

  it('serializes and parses UnixMs canonically', () => {
    expect(serializeUnixMs(MIN_UNIX_MS)).toBe('0');
    expect(serializeUnixMs(MAX_UNIX_MS)).toBe('281474976710655');
    expect(unixMsToBigInt(parseUnixMs('0'))).toBe(0n);
    expect(unixMsToBigInt(parseUnixMs('1700000000000'))).toBe(1_700_000_000_000n);
    expect(unixMsToBigInt(parseUnixMs('281474976710655'))).toBe(281_474_976_710_655n);

    const invalidInputs = [
      '',
      ' ',
      '-0',
      '-1',
      '+1',
      '007',
      '01',
      'abc',
      '12.3',
      '281474976710656',
      '9'.repeat(16),
    ];
    for (const bad of invalidInputs) {
      expectDomainError(() => parseUnixMs(bad), 'INVALID_TIMESTAMP');
    }
  });

  it('verifies UnixMs serialization round-trip with fast-check', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: unixMsToBigInt(MAX_UNIX_MS) }), (rawMs) => {
        const ms = unixMsFromBigInt(rawMs);
        const raw = serializeUnixMs(ms);
        expect(unixMsToBigInt(parseUnixMs(raw))).toBe(rawMs);
      }),
    );
  });
});

// Compile-time type isolation proof checked via `tsc -p tsconfig.test.json --noEmit`.
export function _compileTimeUnixMsTypeAssertions(): void {
  const ts: UnixMs = unixMsFromBigInt(1_700_000_000_000n);
  const money: Money = moneyFromTiyin(100n);
  const qty: Quantity = quantityFromMilli(1000n);

  // @ts-expect-error number cannot be assigned to UnixMs
  const _err1: UnixMs = 1700000000000;
  // @ts-expect-error plain bigint cannot be assigned to UnixMs
  const _err2: UnixMs = 1700000000000n;
  // @ts-expect-error Money cannot be assigned to UnixMs
  const _err3: UnixMs = money;
  // @ts-expect-error Quantity cannot be assigned to UnixMs
  const _err4: UnixMs = qty;
  // @ts-expect-error UnixMs cannot be passed to addUnixMs as deltaMs unless unbranded, wait: bigint accepts UnixMs, but Money cannot take UnixMs
  const _err5: Money = ts;
  // @ts-expect-error UuidV7 cannot be assigned from plain string
  const _err6: UuidV7 = '017f22e2-79b0-7cc3-98c4-dc0c0c07398f';

  void [_err1, _err2, _err3, _err4, _err5, _err6];
}
