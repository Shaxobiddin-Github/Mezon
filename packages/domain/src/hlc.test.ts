import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  type Clock,
  DEFAULT_HLC_MAX_SKEW_MS,
  DomainError,
  type DomainErrorCode,
  HLC_STRING_LENGTH,
  HlcClock,
  type HlcTimestamp,
  MAX_HLC_COUNTER,
  MAX_UNIX_MS,
  MIN_UNIX_MS,
  type UnixMs,
  type UuidV7,
  compareHlc,
  createHlcTimestamp,
  encodeUuidV7,
  parseHlc,
  parseUuidV7,
  serializeHlc,
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

class LocalFakeClock implements Clock {
  constructor(public current: UnixMs) {}
  now(): UnixMs {
    return this.current;
  }
}

const NODE_A: UuidV7 = parseUuidV7('017f22e2-79b0-7cc3-98c4-dc0c0c07398f');
const NODE_B: UuidV7 = parseUuidV7('017f22e2-79b0-7cc3-98c4-dc0c0c073990');
const NODE_C: UuidV7 = parseUuidV7('017f22e2-79b0-7cc3-98c4-dc0c0c073980');

describe('@mezon/domain - Hybrid Logical Clock (HLC)', () => {
  it('serializes and parses fixed 58-char HLC strings cleanly', () => {
    const hlc = createHlcTimestamp(unixMsFromBigInt(1_645_557_742_000n), 42, NODE_A);
    const raw = serializeHlc(hlc);
    expect(raw.length).toBe(HLC_STRING_LENGTH);
    expect(raw).toBe('001645557742000:00042:017f22e2-79b0-7cc3-98c4-dc0c0c07398f');

    const parsed = parseHlc(raw);
    expect(unixMsToBigInt(parsed.physicalMs)).toBe(1_645_557_742_000n);
    expect(parsed.logical).toBe(42);
    expect(parsed.nodeId).toBe(NODE_A);

    const minRaw = serializeHlc(createHlcTimestamp(MIN_UNIX_MS, 0, NODE_C));
    expect(minRaw).toBe('000000000000000:00000:017f22e2-79b0-7cc3-98c4-dc0c0c073980');
    expect(minRaw.length).toBe(58);

    const maxRaw = serializeHlc(createHlcTimestamp(MAX_UNIX_MS, MAX_HLC_COUNTER, NODE_B));
    expect(maxRaw).toBe('281474976710655:65535:017f22e2-79b0-7cc3-98c4-dc0c0c073990');
    expect(maxRaw.length).toBe(58);
  });

  it('rejects malformed HLC values and strings with exact error codes', () => {
    // createHlcTimestamp rejections
    expectDomainError(() => createHlcTimestamp(-1n as UnixMs, 0, NODE_A), 'INVALID_TIMESTAMP');
    expectDomainError(
      () => createHlcTimestamp(unixMsFromBigInt(1000n), -1, NODE_A),
      'INVALID_HLC_COUNTER',
    );
    expectDomainError(
      () => createHlcTimestamp(unixMsFromBigInt(1000n), -0, NODE_A),
      'INVALID_HLC_COUNTER',
    );
    expectDomainError(
      () => createHlcTimestamp(unixMsFromBigInt(1000n), 1.5, NODE_A),
      'INVALID_HLC_COUNTER',
    );
    expectDomainError(
      () => createHlcTimestamp(unixMsFromBigInt(1000n), MAX_HLC_COUNTER + 1, NODE_A),
      'INVALID_HLC_COUNTER',
    );
    expectDomainError(
      () => createHlcTimestamp(unixMsFromBigInt(1000n), 0 / 0, NODE_A), // NaN
      'INVALID_HLC_COUNTER',
    );
    expectDomainError(
      () => createHlcTimestamp(unixMsFromBigInt(1000n), 1 / 0, NODE_A), // Infinity
      'INVALID_HLC_COUNTER',
    );
    expectDomainError(
      () => createHlcTimestamp(unixMsFromBigInt(1000n), 0, 'invalid-uuid' as UuidV7),
      'INVALID_UUID_FORMAT',
    );

    // parseHlc rejections
    expectDomainError(() => parseHlc(''), 'INVALID_HLC_FORMAT');
    expectDomainError(
      () => parseHlc('001645557742000-00001-017f22e2-79b0-7cc3-98c4-dc0c0c07398f'),
      'INVALID_HLC_FORMAT',
    );
    expectDomainError(
      () => parseHlc('00164555774200:00001:017f22e2-79b0-7cc3-98c4-dc0c0c07398f'), // len 57
      'INVALID_HLC_FORMAT',
    );
    expectDomainError(
      () => parseHlc('0001645557742000:00001:017f22e2-79b0-7cc3-98c4-dc0c0c07398f'), // len 59
      'INVALID_HLC_FORMAT',
    );
    expectDomainError(
      () => parseHlc('00164555774200a:00001:017f22e2-79b0-7cc3-98c4-dc0c0c07398f'),
      'INVALID_HLC_FORMAT',
    );
    expectDomainError(
      () => parseHlc('281474976710656:00001:017f22e2-79b0-7cc3-98c4-dc0c0c07398f'),
      'INVALID_TIMESTAMP',
    );
    expectDomainError(
      () => parseHlc('001645557742000:65536:017f22e2-79b0-7cc3-98c4-dc0c0c07398f'),
      'INVALID_HLC_COUNTER',
    );
    expectDomainError(
      () => parseHlc('001645557742000:00001:017f22e2-79b0-4cc3-98c4-dc0c0c07398f'),
      'INVALID_UUID_VERSION',
    );
  });

  it('orders equal (physicalMs, logical) ties deterministically by nodeId', () => {
    const tsA = createHlcTimestamp(unixMsFromBigInt(5000n), 3, NODE_A); // ...8f
    const tsB = createHlcTimestamp(unixMsFromBigInt(5000n), 3, NODE_B); // ...90
    const tsC = createHlcTimestamp(unixMsFromBigInt(5000n), 3, NODE_C); // ...80

    expect(compareHlc(tsC, tsA)).toBe(-1);
    expect(compareHlc(tsA, tsB)).toBe(-1);
    expect(compareHlc(tsB, tsA)).toBe(1);
    expect(compareHlc(tsA, tsA)).toBe(0);

    // PhysicalMs dominates logical, logical dominates nodeId
    const newerMs = createHlcTimestamp(unixMsFromBigInt(5001n), 0, NODE_C);
    const higherLogical = createHlcTimestamp(unixMsFromBigInt(5000n), 4, NODE_C);
    expect(compareHlc(tsB, higherLogical)).toBe(-1);
    expect(compareHlc(higherLogical, newerMs)).toBe(-1);
  });

  it('validates constructor options including negative maxSkewMs and default 5-minute MAX_SKEW', () => {
    expect(DEFAULT_HLC_MAX_SKEW_MS).toBe(300_000n);
    const clock = new LocalFakeClock(MIN_UNIX_MS);

    expectDomainError(
      () => new HlcClock({ clock, nodeId: 'bad-uuid' as UuidV7 }),
      'INVALID_UUID_FORMAT',
    );
    expectDomainError(
      () => new HlcClock({ clock, nodeId: NODE_A, maxSkewMs: -1n }),
      'INVALID_MAX_SKEW',
    );
    expectDomainError(
      () => new HlcClock({ clock, nodeId: NODE_A, maxSkewMs: 10 as unknown as bigint }),
      'INVALID_MAX_SKEW',
    );

    // 0n maxSkewMs is valid (strict no-future-skew tolerance)
    const zeroSkew = new HlcClock({ clock, nodeId: NODE_A, maxSkewMs: 0n });
    expect(zeroSkew.currentState().logical).toBe(0);

    // Invalid initial state validation in constructor
    expectDomainError(
      () =>
        new HlcClock({
          clock,
          nodeId: NODE_A,
          initial: { physicalMs: -1n as UnixMs, logical: 0, nodeId: NODE_A },
        }),
      'INVALID_TIMESTAMP',
    );
    expectDomainError(
      () =>
        new HlcClock({
          clock,
          nodeId: NODE_A,
          initial: { physicalMs: MIN_UNIX_MS, logical: 65_536, nodeId: NODE_A },
        }),
      'INVALID_HLC_COUNTER',
    );
    expectDomainError(
      () =>
        new HlcClock({
          clock,
          nodeId: NODE_A,
          initial: {
            physicalMs: MIN_UNIX_MS,
            logical: 0,
            nodeId: '017f22e2-79b0-4cc3-98c4-dc0c0c07398f' as UuidV7,
          },
        }),
      'INVALID_UUID_VERSION',
    );
  });

  it('maintains monotonicity on same ms and physical clock rollback via now()', () => {
    const clock = new LocalFakeClock(MIN_UNIX_MS);
    const hlc = new HlcClock({ clock, nodeId: NODE_A });

    // Fresh clock at MIN_UNIX_MS (0n) must yield (0n, 0), not (0n, 1)
    const r0 = hlc.now();
    expect(unixMsToBigInt(r0.hlc.physicalMs)).toBe(0n);
    expect(r0.hlc.logical).toBe(0);
    expect(r0.counterOverflow).toBe(false);
    expect(r0.borrowedMs).toBe(0n);

    // Advance physical clock -> resets logical to 0
    clock.current = unixMsFromBigInt(5000n);
    const r1 = hlc.now();
    expect(unixMsToBigInt(r1.hlc.physicalMs)).toBe(5000n);
    expect(r1.hlc.logical).toBe(0);

    // Same ms -> logical increments
    const r2 = hlc.now();
    expect(unixMsToBigInt(r2.hlc.physicalMs)).toBe(5000n);
    expect(r2.hlc.logical).toBe(1);

    // Clock rolls backward to 3000n -> pins physicalMs at 5000n and increments logical
    clock.current = unixMsFromBigInt(3000n);
    const r3 = hlc.now();
    expect(unixMsToBigInt(r3.hlc.physicalMs)).toBe(5000n);
    expect(r3.hlc.logical).toBe(2);
    expect(compareHlc(r2.hlc, r3.hlc)).toBe(-1);
  });

  it('survives 70,000 now() calls in same ms without throwing and tracks borrowedMs', () => {
    const clock = new LocalFakeClock(unixMsFromBigInt(10_000n));
    const hlc = new HlcClock({ clock, nodeId: NODE_A });

    let prev: HlcTimestamp | null = null;
    let overflowCount = 0;

    for (let i = 0; i < 70_000; i++) {
      const res = hlc.now();
      if (i < 65_536) {
        expect(unixMsToBigInt(res.hlc.physicalMs)).toBe(10_000n);
        expect(res.hlc.logical).toBe(i);
        expect(res.counterOverflow).toBe(false);
        expect(res.borrowedMs).toBe(0n);
      } else if (i === 65_536) {
        expect(unixMsToBigInt(res.hlc.physicalMs)).toBe(10_001n);
        expect(res.hlc.logical).toBe(0);
        expect(res.counterOverflow).toBe(true);
        expect(res.borrowedMs).toBe(1n);
        overflowCount += 1;
      } else {
        expect(unixMsToBigInt(res.hlc.physicalMs)).toBe(10_001n);
        expect(res.hlc.logical).toBe(i - 65_536);
        expect(res.counterOverflow).toBe(false);
        expect(res.borrowedMs).toBe(1n);
      }

      if (prev !== null) {
        const isStrictlyGreater =
          res.hlc.physicalMs > prev.physicalMs ||
          (res.hlc.physicalMs === prev.physicalMs && res.hlc.logical > prev.logical);
        expect(isStrictlyGreater).toBe(true);
        if (i < 5 || (i >= 65_533 && i <= 65_540) || i >= 69_995) {
          expect(compareHlc(prev, res.hlc)).toBe(-1);
          expect(serializeHlc(prev) < serializeHlc(res.hlc)).toBe(true);
        }
      }
      prev = res.hlc;
    }

    expect(overflowCount).toBe(1);
    expect(hlc.currentState().borrowedMs).toBe(1n);

    // Physical clock advancing ahead resets logical to 0 while keeping borrowedMs telemetry
    clock.current = unixMsFromBigInt(20_000n);
    const afterCatchup = hlc.now();
    expect(unixMsToBigInt(afterCatchup.hlc.physicalMs)).toBe(20_000n);
    expect(afterCatchup.hlc.logical).toBe(0);
    expect(afterCatchup.counterOverflow).toBe(false);
    expect(afterCatchup.borrowedMs).toBe(1n);
  });

  it('defeats attacker remote(pt, 65535) DoS attack and continues growing via now()', () => {
    const pt = unixMsFromBigInt(1_700_000_000_000n);
    const clock = new LocalFakeClock(pt);
    const hlc = new HlcClock({ clock, nodeId: NODE_A });

    const attackerRemote = createHlcTimestamp(pt, MAX_HLC_COUNTER, NODE_B);
    const recvRes = hlc.receive(attackerRemote);
    expect(recvRes.skewClamped).toBe(false);
    expect(recvRes.counterOverflow).toBe(true);
    expect(recvRes.borrowedMs).toBe(1n);
    expect(unixMsToBigInt(recvRes.hlc.physicalMs)).toBe(1_700_000_000_001n);
    expect(recvRes.hlc.logical).toBe(0);
    expect(compareHlc(attackerRemote, recvRes.hlc)).toBe(-1);

    // Next local now() at unchanged pt must succeed cleanly and be strictly greater
    const nextLocal = hlc.now();
    expect(nextLocal.counterOverflow).toBe(false);
    expect(nextLocal.borrowedMs).toBe(1n);
    expect(unixMsToBigInt(nextLocal.hlc.physicalMs)).toBe(1_700_000_000_001n);
    expect(nextLocal.hlc.logical).toBe(1);
    expect(compareHlc(recvRes.hlc, nextLocal.hlc)).toBe(-1);
  });

  it('defines exact behavior at MAX_UNIX_MS counter boundary without state corruption', () => {
    const clock = new LocalFakeClock(MAX_UNIX_MS);
    const hlc = new HlcClock({
      clock,
      nodeId: NODE_A,
      initial: createHlcTimestamp(MAX_UNIX_MS, MAX_HLC_COUNTER - 1, NODE_A),
    });

    // Stepping to (MAX_UNIX_MS, 65535) succeeds
    const atMax = hlc.now();
    expect(unixMsToBigInt(atMax.hlc.physicalMs)).toBe(unixMsToBigInt(MAX_UNIX_MS));
    expect(atMax.hlc.logical).toBe(MAX_HLC_COUNTER);
    expect(atMax.counterOverflow).toBe(false);

    // Stepping beyond (MAX_UNIX_MS, 65535) exceeds 48-bit UnixMs and rejects atomically
    expectDomainError(() => hlc.now(), 'INVALID_TIMESTAMP');
    expect(hlc.currentState().logical).toBe(MAX_HLC_COUNTER);
    expect(unixMsToBigInt(hlc.currentState().physicalMs)).toBe(unixMsToBigInt(MAX_UNIX_MS));
    expect(hlc.currentState().borrowedMs).toBe(0n);

    // receive(MAX_UNIX_MS, 65535) when pt == MAX_UNIX_MS also rejects atomically
    expectDomainError(
      () => hlc.receive(createHlcTimestamp(MAX_UNIX_MS, MAX_HLC_COUNTER, NODE_B)),
      'INVALID_TIMESTAMP',
    );
    expect(hlc.currentState().borrowedMs).toBe(0n);

    // receive(MAX_UNIX_MS - 1, 65535) when pt == MAX_UNIX_MS - 1 rolls cleanly onto MAX_UNIX_MS
    const nearMaxClock = new LocalFakeClock(unixMsFromBigInt(unixMsToBigInt(MAX_UNIX_MS) - 1n));
    const nearMaxHlc = new HlcClock({ clock: nearMaxClock, nodeId: NODE_A });
    const rolledOntoMax = nearMaxHlc.receive(
      createHlcTimestamp(
        unixMsFromBigInt(unixMsToBigInt(MAX_UNIX_MS) - 1n),
        MAX_HLC_COUNTER,
        NODE_B,
      ),
    );
    expect(unixMsToBigInt(rolledOntoMax.hlc.physicalMs)).toBe(unixMsToBigInt(MAX_UNIX_MS));
    expect(rolledOntoMax.hlc.logical).toBe(0);
    expect(rolledOntoMax.counterOverflow).toBe(true);
  });

  it('handles receive() across remote ahead (within skew), behind, and equal cases', () => {
    const clock = new LocalFakeClock(unixMsFromBigInt(10_000n));
    const hlc = new HlcClock({ clock, nodeId: NODE_A, maxSkewMs: 300_000n });

    // Local starts at (10_000, 0)
    const l0 = hlc.now().hlc;
    expect(l0.logical).toBe(0);

    // Case 1: remote strictly ahead of both pt and local, at exact maxSkewMs boundary (NOT clamped)
    const remoteAtSkewMax = createHlcTimestamp(unixMsFromBigInt(10_000n + 300_000n), 7, NODE_B);
    const resAhead = hlc.receive(remoteAtSkewMax);
    expect(resAhead.skewClamped).toBe(false);
    expect(resAhead.skewMs).toBe(0n);
    expect(unixMsToBigInt(resAhead.hlc.physicalMs)).toBe(310_000n);
    expect(resAhead.hlc.logical).toBe(8);
    expect(compareHlc(remoteAtSkewMax, resAhead.hlc)).toBe(-1);

    // Case 2: remote behind local (and pt behind local): local advances logical only
    const remoteBehind = createHlcTimestamp(unixMsFromBigInt(5_000n), 99, NODE_B);
    const resBehind = hlc.receive(remoteBehind);
    expect(resBehind.skewClamped).toBe(false);
    expect(unixMsToBigInt(resBehind.hlc.physicalMs)).toBe(310_000n);
    expect(resBehind.hlc.logical).toBe(9);

    // Case 3a: remote equal physicalMs with higher logical -> max(9, 20) + 1 = 21
    const remoteEqualHigher = createHlcTimestamp(unixMsFromBigInt(310_000n), 20, NODE_B);
    const resEqual1 = hlc.receive(remoteEqualHigher);
    expect(resEqual1.hlc.logical).toBe(21);

    // Case 3b: remote equal physicalMs with lower logical -> max(21, 5) + 1 = 22
    const remoteEqualLower = createHlcTimestamp(unixMsFromBigInt(310_000n), 5, NODE_B);
    const resEqual2 = hlc.receive(remoteEqualLower);
    expect(resEqual2.hlc.logical).toBe(22);

    // Case 3c: remote equal physicalMs with exact equal logical -> max(22, 22) + 1 = 23
    const remoteEqualSame = createHlcTimestamp(unixMsFromBigInt(310_000n), 22, NODE_B);
    const resEqual3 = hlc.receive(remoteEqualSame);
    expect(resEqual3.hlc.logical).toBe(23);

    // Case 4: physical clock strictly ahead of both local and remote -> resets logical to 0
    clock.current = unixMsFromBigInt(400_000n);
    const resPtAhead = hlc.receive(createHlcTimestamp(unixMsFromBigInt(350_000n), 50, NODE_B));
    expect(unixMsToBigInt(resPtAhead.hlc.physicalMs)).toBe(400_000n);
    expect(resPtAhead.hlc.logical).toBe(0);

    // Fresh HlcClock (!hasState) receiving remote behind/equal/ahead of pt
    const freshBehind = new HlcClock({
      clock: new LocalFakeClock(unixMsFromBigInt(5_000n)),
      nodeId: NODE_A,
    }).receive(createHlcTimestamp(unixMsFromBigInt(4_000n), 10, NODE_B));
    expect(unixMsToBigInt(freshBehind.hlc.physicalMs)).toBe(5_000n);
    expect(freshBehind.hlc.logical).toBe(0);

    const freshEqual = new HlcClock({
      clock: new LocalFakeClock(unixMsFromBigInt(5_000n)),
      nodeId: NODE_A,
    }).receive(createHlcTimestamp(unixMsFromBigInt(5_000n), 10, NODE_B));
    expect(unixMsToBigInt(freshEqual.hlc.physicalMs)).toBe(5_000n);
    expect(freshEqual.hlc.logical).toBe(11);

    const freshAhead = new HlcClock({
      clock: new LocalFakeClock(unixMsFromBigInt(5_000n)),
      nodeId: NODE_A,
    }).receive(createHlcTimestamp(unixMsFromBigInt(6_000n), 10, NODE_B));
    expect(unixMsToBigInt(freshAhead.hlc.physicalMs)).toBe(6_000n);
    expect(freshAhead.hlc.logical).toBe(11);
  });

  it('clamps remote timestamps beyond MAX_SKEW so broken clocks cannot beat valid edits', () => {
    const serverTime = unixMsFromBigInt(1_700_000_000_000n);
    const clock = new LocalFakeClock(serverTime);
    const serverHlc = new HlcClock({ clock, nodeId: NODE_A });

    // Custom maxSkewMs = 1000n check
    const customSkewClock = new HlcClock({
      clock: new LocalFakeClock(unixMsFromBigInt(10_000n)),
      nodeId: NODE_A,
      maxSkewMs: 1_000n,
    });
    expect(
      customSkewClock.receive(createHlcTimestamp(unixMsFromBigInt(11_000n), 0, NODE_B)).skewClamped,
    ).toBe(false);
    const customOver = customSkewClock.receive(
      createHlcTimestamp(unixMsFromBigInt(11_001n), 999, NODE_B),
    );
    expect(customOver.skewClamped).toBe(true);
    expect(customOver.skewMs).toBe(1_001n);
    expect(unixMsToBigInt(customOver.hlc.physicalMs)).toBe(11_000n);
    expect(customOver.hlc.logical).toBe(2);

    // Broken terminal clock is 1 hour + 1 ms ahead with logical=65535
    const brokenFutureMs = unixMsFromBigInt(unixMsToBigInt(serverTime) + 3_600_001n);
    const brokenRemote = createHlcTimestamp(brokenFutureMs, MAX_HLC_COUNTER, NODE_B);

    const clampedRes = serverHlc.receive(brokenRemote);
    expect(clampedRes.skewClamped).toBe(true);
    expect(clampedRes.skewMs).toBe(3_600_001n);
    expect(clampedRes.counterOverflow).toBe(false);
    expect(unixMsToBigInt(clampedRes.hlc.physicalMs)).toBe(unixMsToBigInt(serverTime));
    expect(clampedRes.hlc.logical).toBe(0);

    // Honest terminal editing 1ms later beats the clamped broken-clock event
    clock.current = unixMsFromBigInt(unixMsToBigInt(serverTime) + 1n);
    const honestRes = serverHlc.now();
    expect(compareHlc(honestRes.hlc, clampedRes.hlc)).toBe(1);
  });

  it('rejects untrusted invalid remote HlcTimestamp objects atomically without changing state', () => {
    const clock = new LocalFakeClock(unixMsFromBigInt(5_000n));
    const hlc = new HlcClock({ clock, nodeId: NODE_A });
    const initialSnap = hlc.now().hlc; // (5000n, 0)

    const badRemotes: Array<{ value: HlcTimestamp; code: DomainErrorCode }> = [
      { value: null as unknown as HlcTimestamp, code: 'INVALID_HLC_FORMAT' },
      {
        value: { physicalMs: -1n as UnixMs, logical: 0, nodeId: NODE_B },
        code: 'INVALID_TIMESTAMP',
      },
      {
        value: {
          physicalMs: (unixMsToBigInt(MAX_UNIX_MS) + 1n) as UnixMs,
          logical: 0,
          nodeId: NODE_B,
        },
        code: 'INVALID_TIMESTAMP',
      },
      {
        value: { physicalMs: unixMsFromBigInt(5_000n), logical: -1, nodeId: NODE_B },
        code: 'INVALID_HLC_COUNTER',
      },
      {
        value: { physicalMs: unixMsFromBigInt(5_000n), logical: -0, nodeId: NODE_B },
        code: 'INVALID_HLC_COUNTER',
      },
      {
        value: { physicalMs: unixMsFromBigInt(5_000n), logical: 2.5, nodeId: NODE_B },
        code: 'INVALID_HLC_COUNTER',
      },
      {
        value: { physicalMs: unixMsFromBigInt(5_000n), logical: 65_536, nodeId: NODE_B },
        code: 'INVALID_HLC_COUNTER',
      },
      {
        value: { physicalMs: unixMsFromBigInt(5_000n), logical: 0 / 0, nodeId: NODE_B },
        code: 'INVALID_HLC_COUNTER',
      },
      {
        value: {
          physicalMs: unixMsFromBigInt(5_000n),
          logical: 0,
          nodeId: '017f22e2-79b0-4cc3-98c4-dc0c0c07398f' as UuidV7,
        },
        code: 'INVALID_UUID_VERSION',
      },
    ];

    for (const bad of badRemotes) {
      expectDomainError(() => hlc.receive(bad.value), bad.code);
      const stateAfter = hlc.currentState();
      expect(unixMsToBigInt(stateAfter.physicalMs)).toBe(5_000n);
      expect(stateAfter.logical).toBe(0);
      expect(stateAfter.borrowedMs).toBe(0n);
    }

    // Next now() continues cleanly from (5000n, 0) -> (5000n, 1)
    const afterAll = hlc.now().hlc;
    expect(afterAll.logical).toBe(1);
    expect(compareHlc(initialSnap, afterAll)).toBe(-1);
  });

  it('guarantees first now() is strictly greater than initial across restarts and clock rollbacks', () => {
    const persisted = createHlcTimestamp(unixMsFromBigInt(10_000n), 42, NODE_A);
    const clockRolledBack = new LocalFakeClock(unixMsFromBigInt(4_000n));
    const restarted = new HlcClock({
      clock: clockRolledBack,
      nodeId: NODE_A,
      initial: persisted,
    });

    const firstAfterRestart = restarted.now();
    expect(unixMsToBigInt(firstAfterRestart.hlc.physicalMs)).toBe(10_000n);
    expect(firstAfterRestart.hlc.logical).toBe(43);
    expect(compareHlc(firstAfterRestart.hlc, persisted)).toBe(1);

    // Distinct edge case: initial === (0n, 0) at pt = 0n must yield (0n, 1) > initial
    const zeroInit = createHlcTimestamp(MIN_UNIX_MS, 0, NODE_A);
    const restartedAtZero = new HlcClock({
      clock: new LocalFakeClock(MIN_UNIX_MS),
      nodeId: NODE_A,
      initial: zeroInit,
    });
    const firstAtZero = restartedAtZero.now();
    expect(unixMsToBigInt(firstAtZero.hlc.physicalMs)).toBe(0n);
    expect(firstAtZero.hlc.logical).toBe(1);
    expect(compareHlc(firstAtZero.hlc, zeroInit)).toBe(1);

    // Initial at logical === 65535 with clock rollback -> advances physicalMs + 1n
    const fullInit = createHlcTimestamp(unixMsFromBigInt(10_000n), MAX_HLC_COUNTER, NODE_A);
    const restartedFull = new HlcClock({
      clock: clockRolledBack,
      nodeId: NODE_A,
      initial: fullInit,
    });
    const firstFromFull = restartedFull.now();
    expect(unixMsToBigInt(firstFromFull.hlc.physicalMs)).toBe(10_001n);
    expect(firstFromFull.hlc.logical).toBe(0);
    expect(firstFromFull.counterOverflow).toBe(true);
    expect(firstFromFull.borrowedMs).toBe(1n);
    expect(compareHlc(firstFromFull.hlc, fullInit)).toBe(1);
  });

  it('verifies format/parse round-trip, lexical order equivalence, and receive monotonicity via fast-check', () => {
    const hlcArb = fc
      .record({
        physicalMs: fc.bigInt({ min: 0n, max: unixMsToBigInt(MAX_UNIX_MS) }),
        logical: fc.integer({ min: 0, max: MAX_HLC_COUNTER }),
        randBytes: fc.uint8Array({ minLength: 10, maxLength: 10 }),
      })
      .map(({ physicalMs, logical, randBytes }) => {
        const ms = unixMsFromBigInt(physicalMs);
        return createHlcTimestamp(ms, logical, encodeUuidV7(ms, randBytes));
      });

    // 1. Format -> parse -> format round-trip
    fc.assert(
      fc.property(hlcArb, (hlc) => {
        const encoded = serializeHlc(hlc);
        const decoded = parseHlc(encoded);
        expect(encoded.length).toBe(HLC_STRING_LENGTH);
        expect(compareHlc(hlc, decoded)).toBe(0);
        expect(serializeHlc(decoded)).toBe(encoded);
      }),
    );

    // 2. String lexicographical order === logical compareHlc order (including ties on ms + logical)
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: unixMsToBigInt(MAX_UNIX_MS) }),
        fc.bigInt({ min: 0n, max: unixMsToBigInt(MAX_UNIX_MS) }),
        fc.integer({ min: 0, max: MAX_HLC_COUNTER }),
        fc.integer({ min: 0, max: MAX_HLC_COUNTER }),
        fc.constantFrom(NODE_A, NODE_B, NODE_C),
        fc.constantFrom(NODE_A, NODE_B, NODE_C),
        (msA, msB, logA, logB, idA, idB) => {
          const a = createHlcTimestamp(unixMsFromBigInt(msA), logA, idA);
          const b = createHlcTimestamp(unixMsFromBigInt(msB), logB, idB);
          const strA = serializeHlc(a);
          const strB = serializeHlc(b);
          const strCmp = strA < strB ? -1 : strA > strB ? 1 : 0;
          expect(compareHlc(a, b)).toBe(strCmp);
        },
      ),
    );

    // 3. Monotonicity across random clock jumps and remote receives
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            clockDeltaMs: fc.bigInt({ min: -5_000n, max: 10_000n }),
            op: fc.constantFrom<'now' | 'receive'>('now', 'receive'),
            remoteOffsetMs: fc.bigInt({ min: -10_000n, max: 500_000n }),
            remoteLogical: fc.integer({ min: 0, max: MAX_HLC_COUNTER }),
          }),
          { minLength: 2, maxLength: 30 },
        ),
        (steps) => {
          let currentClock = 1_700_000_000_000n;
          const clock = new LocalFakeClock(unixMsFromBigInt(currentClock));
          const hlcClock = new HlcClock({ clock, nodeId: NODE_A });

          let prev: HlcTimestamp | null = null;
          for (const step of steps) {
            const candidate = currentClock + step.clockDeltaMs;
            currentClock = candidate >= 0n ? candidate : 0n;
            clock.current = unixMsFromBigInt(currentClock);

            if (step.op === 'now') {
              const res = hlcClock.now();
              if (prev !== null) {
                expect(compareHlc(prev, res.hlc)).toBe(-1);
              }
              prev = res.hlc;
            } else {
              const rRaw = currentClock + step.remoteOffsetMs;
              const rMs = unixMsFromBigInt(rRaw >= 0n ? rRaw : 0n);
              const remote = createHlcTimestamp(rMs, step.remoteLogical, NODE_B);
              const res = hlcClock.receive(remote);
              if (prev !== null) {
                expect(compareHlc(prev, res.hlc)).toBe(-1);
              }
              if (!res.skewClamped) {
                expect(compareHlc(remote, res.hlc)).toBe(-1);
              }
              prev = res.hlc;
            }
          }
        },
      ),
    );
  });
});
