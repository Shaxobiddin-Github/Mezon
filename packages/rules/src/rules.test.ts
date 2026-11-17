import { DomainError, getBusinessDateKey, unixMsFromBigInt } from '@mezon/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type RulesCartLineInput,
  type RulesContext,
  type RulesPackageState,
  type RulesPaymentInput,
  type RulesSignatureVerifier,
  type TrustedRuleKey,
  type VerifiedRulesPackage,
  PRODUCTION_TRUSTED_RULE_KEYS,
  RULES_SIGNING_PREFIX,
  buildRulesSigningMessage,
  canonicalJson,
  evaluate,
  matchesMxikList,
  parseRulesEnvelope,
  parseRulesPayload,
  resolveRulesPackageState,
  rulesPayloadToWire,
  verifyRulesPackage,
} from './index.js';

/**
 * T3.2 pure tests. Real Ed25519 is exercised in the hub (`apps/hub/src/rules.test.ts`); here a
 * deterministic TEST verifier checks the flow. All MXIK values and limits are SYNTHETIC — the real
 * limit (176 mln so'm) and lists live only in the owner-signed package.
 */

const DAY = 86_400_000n;
const NOW = 1_763_000_000_000n;
const tz = 'Asia/Tashkent';
const toDateKey = (ms: bigint) => getBusinessDateKey(unixMsFromBigInt(ms), tz);

const FORBIDDEN = '99900000000000001';
const FORBIDDEN_PREFIXED = '99910000000000007';
const OK_A = '10101001001000001';
const OK_B = '10101001001000002';
const EXEMPT = '55500000000000001';
const LIMIT = 1_000_000n; // synthetic (10 000.00 so'm)

interface Wire {
  packageVersion: string;
  issuedAtMs: string;
  validUntilMs: string;
  sourceRefs: string[];
  cashForbidden: { exact: string[]; prefixes: string[] };
  perMxikCashLimit: {
    limitTiyin: string;
    appliesTo: 'cash' | 'mxikTotal';
    inclusive: boolean;
    exempt: { exact: string[]; prefixes: string[] };
  } | null;
  expiredGoods: { enabled: boolean };
}

function wire(over: Partial<Wire> = {}): Wire {
  return {
    packageVersion: '3',
    issuedAtMs: (NOW - DAY).toString(),
    validUntilMs: (NOW + 30n * DAY).toString(),
    sourceRefs: ['SINTETIK-TEST'],
    cashForbidden: { exact: [FORBIDDEN], prefixes: ['9991'] },
    perMxikCashLimit: {
      limitTiyin: LIMIT.toString(),
      appliesTo: 'cash',
      inclusive: true,
      exempt: { exact: [EXEMPT], prefixes: [] },
    },
    expiredGoods: { enabled: true },
    ...over,
  };
}

/** TEST-ONLY verifier: accepts iff signature equals the pseudo-signature of the message. */
function pseudoSig(message: string, secret: string): string {
  let h = 0n;
  for (const ch of `${secret}|${message}`) {
    h = (h * 131n + BigInt(ch.codePointAt(0) ?? 0)) % (1n << 255n);
  }
  const hex = h.toString(16).padStart(128, '0').slice(-128);
  const alphabet = 'ABCDEFGHIJKLMNOP';
  const body = hex
    .slice(0, 86)
    .split('')
    .map((c) => alphabet['0123456789abcdef'.indexOf(c)] ?? 'A')
    .join('');
  return `${body}==`;
}
const testVerifier: RulesSignatureVerifier = {
  verifyEd25519: (pub, message, sig) => sig === pseudoSig(message, pub),
};
const KEY_A: TrustedRuleKey = {
  keyId: 'test-a',
  publicKeyB64: 'PUB-A',
  validFromMs: 0n,
  validUntilMs: null,
};
const KEY_B: TrustedRuleKey = {
  keyId: 'test-b',
  publicKeyB64: 'PUB-B',
  validFromMs: 0n,
  validUntilMs: null,
};

function signWire(w: Wire, key: TrustedRuleKey, keyIdInEnvelope = key.keyId) {
  return {
    format: 'mezon-rules',
    formatVersion: 1,
    keyId: keyIdInEnvelope,
    payload: w,
    signature: pseudoSig(
      buildRulesSigningMessage(key.keyId, parseRulesPayload(w)),
      key.publicKeyB64,
    ),
  };
}

function verified(w: Wire = wire()): VerifiedRulesPackage {
  return verifyRulesPackage(signWire(w, KEY_A), [KEY_A], testVerifier);
}

function ctx(over: Partial<RulesContext> = {}): RulesContext {
  const pkg = over.pkg === undefined ? verified() : over.pkg;
  const state: RulesPackageState = over.pkgState ?? (pkg ? 'ok' : 'missing');
  return {
    nowMs: NOW,
    todayDateKey: toDateKey(NOW),
    toDateKey,
    pkg,
    pkgState: state,
    fiscalMode: false,
    phase: 'final',
    ...over,
  };
}

function line(id: string, over: Partial<RulesCartLineInput> = {}): RulesCartLineInput {
  return {
    lineId: id,
    lineKind: 'catalog',
    mxik: OK_A,
    qtyMilli: 1000n,
    finalTotalTiyin: 100_000n,
    batchExpiries: [],
    ...over,
  };
}

const cash = (amountTiyin: bigint): RulesPaymentInput => ({ method: 'cash', amountTiyin });
const card = (amountTiyin: bigint): RulesPaymentInput => ({ method: 'card', amountTiyin });
const codes = (fs: readonly { code: string }[]) => fs.map((f) => f.code);

describe('@mezon/rules — canonical JSON', () => {
  it('sorts keys, keeps array order, no whitespace; golden string', () => {
    expect(canonicalJson({ b: 1, a: ['z', 'y'], c: { y: true, x: null } })).toBe(
      '{"a":["z","y"],"b":1,"c":{"x":null,"y":true}}',
    );
    expect(canonicalJson('"q"\n')).toBe(JSON.stringify('"q"\n'));
  });

  it('rejects floats, NaN, undefined, bigint and non-plain objects', () => {
    for (const bad of [1.5, 0 / 0, Infinity, { a: undefined }, 1n, new Map()]) {
      expect(() => canonicalJson(bad as unknown)).toThrow(DomainError);
    }
  });

  it('property: key insertion order never changes the canonical string', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ maxLength: 6 }),
          fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        ),
        (obj) => {
          const reversed = Object.fromEntries(Object.entries(obj).reverse());
          expect(canonicalJson(reversed)).toBe(canonicalJson(obj));
        },
      ),
    );
  });
});

describe('@mezon/rules — package format (owner answers 79df8b8)', () => {
  it('round-trips wire → typed → wire exactly (incl. limit appliesTo/inclusive, null limit)', () => {
    expect(rulesPayloadToWire(parseRulesPayload(wire()))).toEqual(wire());
    const noLimit = wire({ perMxikCashLimit: null });
    expect(rulesPayloadToWire(parseRulesPayload(noLimit))).toEqual(noLimit);
  });

  it('removed fields are rejected (prescription S5, social card S6) and the package has no organizationId', () => {
    for (const extra of [
      { prescriptionRequired: { exact: [], prefixes: [] } },
      { socialCard: { enabled: true } },
      { organizationId: '01950000-0000-7000-8000-000000000001' },
    ]) {
      expect(() => parseRulesPayload({ ...wire(), ...extra })).toThrow(/unknown field/);
    }
  });

  it('rejects malformed values', () => {
    const lim = wire().perMxikCashLimit!;
    const bad: unknown[] = [
      { ...wire(), packageVersion: '03' },
      { ...wire(), packageVersion: 3 },
      { ...wire(), packageVersion: '0' },
      { ...wire(), validUntilMs: wire().issuedAtMs },
      { ...wire(), cashForbidden: { exact: [' 999'], prefixes: [] } },
      { ...wire(), perMxikCashLimit: { ...lim, appliesTo: 'total' } },
      { ...wire(), perMxikCashLimit: { ...lim, inclusive: 'yes' } },
      { ...wire(), perMxikCashLimit: { ...lim, limitTiyin: '-1' } },
      (() => {
        const { inclusive: _i, ...rest } = lim;
        return { ...wire(), perMxikCashLimit: rest };
      })(),
    ];
    for (const b of bad) {
      expect(() => parseRulesPayload(b), JSON.stringify(b)).toThrow(DomainError);
    }
    expect(() => parseRulesEnvelope({ ...signWire(wire(), KEY_A), signature: 'short' })).toThrow(
      DomainError,
    );
    expect(() => parseRulesEnvelope({ ...signWire(wire(), KEY_A), formatVersion: 2 })).toThrow(
      DomainError,
    );
  });
});

describe('@mezon/rules — verification flow', () => {
  it('signed message has the domain prefix and includes keyId', () => {
    const msg = buildRulesSigningMessage('test-a', parseRulesPayload(wire()));
    expect(msg.startsWith(RULES_SIGNING_PREFIX)).toBe(true);
    expect(msg).toContain('"keyId":"test-a"');
  });

  it('accepts a correctly signed package; rejects untrusted key, wrong key, tampered payload', () => {
    expect(verified().payload.packageVersion).toBe(3n);
    expect(() => verifyRulesPackage(signWire(wire(), KEY_A), [KEY_B], testVerifier)).toThrow(
      /Unknown rules key/,
    );
    expect(() =>
      verifyRulesPackage(signWire(wire(), KEY_B, 'test-a'), [KEY_A, KEY_B], testVerifier),
    ).toThrow(/signature/);
    const tampered = { ...signWire(wire(), KEY_A), payload: wire({ packageVersion: '4' }) };
    expect(() => verifyRulesPackage(tampered, [KEY_A], testVerifier)).toThrow(/signature/);
  });

  it('enforces the key validity window at issue time (rotation)', () => {
    const expiredKey = { ...KEY_A, validUntilMs: NOW - 2n * DAY };
    expect(() => verifyRulesPackage(signWire(wire(), KEY_A), [expiredKey], testVerifier)).toThrow(
      /not valid at package issue time/,
    );
    const futureKey = { ...KEY_A, validFromMs: NOW };
    expect(() => verifyRulesPackage(signWire(wire(), KEY_A), [futureKey], testVerifier)).toThrow(
      /not valid at package issue time/,
    );
  });

  it('a verifier that throws is treated as an invalid signature', () => {
    const throwing: RulesSignatureVerifier = {
      verifyEd25519: () => {
        throw new Error('boom');
      },
    };
    expect(() => verifyRulesPackage(signWire(wire(), KEY_A), [KEY_A], throwing)).toThrow(
      /signature/,
    );
  });

  it('production trusted key list is empty until the owner provides a key (S2)', () => {
    expect(PRODUCTION_TRUSTED_RULE_KEYS).toEqual([]);
  });

  it('package state: missing / invalid / ok / expired (boundary at validUntil)', () => {
    const pkg = verified();
    expect(resolveRulesPackageState(null, false, NOW)).toBe('missing');
    expect(resolveRulesPackageState(pkg, true, NOW)).toBe('invalid');
    expect(resolveRulesPackageState(pkg, false, pkg.payload.validUntilMs)).toBe('ok');
    expect(resolveRulesPackageState(pkg, false, pkg.payload.validUntilMs + 1n)).toBe('expired');
  });
});

describe('@mezon/rules — package states (§8)', () => {
  it('missing/invalid warn when fiscal off, block when on; expired warns and still applies rules', () => {
    for (const state of ['missing', 'invalid'] as const) {
      const code = state === 'missing' ? 'PACKAGE_MISSING' : 'PACKAGE_INVALID';
      const off = evaluate(
        { lines: [line('l1')] },
        [cash(1n)],
        ctx({ pkg: null, pkgState: state }),
      );
      expect(codes(off.warn)).toContain(code);
      expect(off.block).toEqual([]);
      const on = evaluate(
        { lines: [line('l1')] },
        [cash(1n)],
        ctx({ pkg: null, pkgState: state, fiscalMode: true }),
      );
      expect(codes(on.block)).toEqual([code]);
    }
    const expired = evaluate(
      { lines: [line('l1', { mxik: FORBIDDEN })] },
      [cash(100_000n)],
      ctx({ pkgState: 'expired' }),
    );
    expect(codes(expired.warn)).toContain('PACKAGE_EXPIRED');
    expect(codes(expired.block)).toEqual(['CASH_FORBIDDEN_MXIK']);
    expect(expired.packageVersion).toBe('3');
  });
});

describe('@mezon/rules — cash ban (CASH_FORBIDDEN_MXIK / MIXED_RECEIPT_CASHLESS)', () => {
  it('exact and prefix matches; prefix boundary is literal (9990… ≠ 9991…)', () => {
    const list = { exact: [FORBIDDEN], prefixes: ['9991'] };
    expect(matchesMxikList(FORBIDDEN, list)).toBe(true);
    expect(matchesMxikList(FORBIDDEN_PREFIXED, list)).toBe(true);
    expect(matchesMxikList('99900000000000002', list)).toBe(false);
    expect(matchesMxikList('999', list)).toBe(false);
    // prefix only: the forbidden code appearing in the MIDDLE of a MXIK must not match
    expect(matchesMxikList('10099910000000000', list)).toBe(false);
    expect(matchesMxikList('10099900000000001', list)).toBe(false);
    expect(matchesMxikList(null, list)).toBe(false);
  });

  it('only-forbidden receipt + any cash → CASH_FORBIDDEN_MXIK; mixed receipt → MIXED_RECEIPT_CASHLESS; even 1 tiyin cash', () => {
    const only = evaluate(
      { lines: [line('f', { mxik: FORBIDDEN })] },
      [card(99_999n), cash(1n)],
      ctx(),
    );
    expect(codes(only.block)).toEqual(['CASH_FORBIDDEN_MXIK']);
    expect(only.block[0]?.lineIds).toEqual(['f']);
    const mixed = evaluate(
      { lines: [line('ok'), line('f', { mxik: FORBIDDEN_PREFIXED })] },
      [cash(200_000n)],
      ctx(),
    );
    expect(codes(mixed.block)).toEqual(['MIXED_RECEIPT_CASHLESS']);
    expect(mixed.block[0]?.lineIds).toEqual(['f']);
  });

  it('cashless payments (card/uzqr/advance/…) never trigger the ban; no package → no ban', () => {
    for (const method of [
      'card',
      'uzqr',
      'payme',
      'click',
      'uzum',
      'social_card',
      'other',
      'advance',
    ]) {
      const res = evaluate(
        { lines: [line('ok'), line('f', { mxik: FORBIDDEN })] },
        [{ method, amountTiyin: 200_000n }],
        ctx(),
      );
      expect(res.block, method).toEqual([]);
    }
    expect(
      evaluate({ lines: [line('f', { mxik: FORBIDDEN })] }, [cash(100_000n)], ctx({ pkg: null }))
        .block,
    ).toEqual([]);
  });

  it('empty forbidden list (owner S3: none today) never blocks', () => {
    const pkg = verified(
      wire({ cashForbidden: { exact: [], prefixes: [] }, perMxikCashLimit: null }),
    );
    expect(
      evaluate({ lines: [line('f', { mxik: FORBIDDEN })] }, [cash(100_000n)], ctx({ pkg })).block,
    ).toEqual([]);
  });
});

describe('@mezon/rules — MXIK_CASH_LIMIT boundary table (synthetic limit)', () => {
  const limitPkg = (appliesTo: 'cash' | 'mxikTotal', inclusive: boolean) =>
    verified(
      wire({
        cashForbidden: { exact: [], prefixes: [] },
        perMxikCashLimit: {
          limitTiyin: LIMIT.toString(),
          appliesTo,
          inclusive,
          exempt: { exact: [EXEMPT], prefixes: [] },
        },
      }),
    );

  const table: ReadonlyArray<readonly [string, bigint, boolean, boolean]> = [
    // [label, amount, inclusive, expectBlock]
    ['limit − 1, inclusive', LIMIT - 1n, true, false],
    ['limit, inclusive (equal allowed)', LIMIT, true, false],
    ['limit + 1, inclusive', LIMIT + 1n, true, true],
    ['limit − 1, exclusive', LIMIT - 1n, false, false],
    ['limit, exclusive (equal blocked)', LIMIT, false, true],
    ['limit + 1, exclusive', LIMIT + 1n, false, true],
  ];

  for (const appliesTo of ['cash', 'mxikTotal'] as const) {
    for (const [label, amount, inclusive, expectBlock] of table) {
      it(`${appliesTo}: ${label}`, () => {
        const res = evaluate(
          { lines: [line('l1', { finalTotalTiyin: amount })] },
          [cash(amount)],
          ctx({ pkg: limitPkg(appliesTo, inclusive) }),
        );
        expect(codes(res.block)).toEqual(expectBlock ? ['MXIK_CASH_LIMIT'] : []);
      });
    }
  }

  it('cash mode attributes cash proportionally: big MXIK paid mostly by card stays under the limit', () => {
    const pkg = limitPkg('cash', true);
    // Line A 2×limit, line B small; only 50% cash → A's cash share = limit (allowed, inclusive)
    const lines = [
      line('a', { finalTotalTiyin: 2n * LIMIT }),
      line('b', { mxik: OK_B, finalTotalTiyin: 0n }),
    ];
    expect(evaluate({ lines }, [cash(LIMIT), card(LIMIT)], ctx({ pkg })).block).toEqual([]);
    const more = evaluate({ lines }, [cash(LIMIT + 2n), card(LIMIT - 2n)], ctx({ pkg }));
    expect(codes(more.block)).toEqual(['MXIK_CASH_LIMIT']);
    // mxikTotal mode: same receipt blocks as soon as ANY cash is used
    const total = evaluate(
      { lines },
      [cash(1n), card(2n * LIMIT - 1n)],
      ctx({ pkg: limitPkg('mxikTotal', true) }),
    );
    expect(codes(total.block)).toEqual(['MXIK_CASH_LIMIT']);
  });

  it('split lines of one MXIK are summed; two MXIKs each under the limit pass; exempt MXIK ignored; no cash → no limit', () => {
    const pkg = limitPkg('mxikTotal', true);
    const half = LIMIT / 2n + 1n;
    const split = evaluate(
      { lines: [line('a1', { finalTotalTiyin: half }), line('a2', { finalTotalTiyin: half })] },
      [cash(2n * half)],
      ctx({ pkg }),
    );
    expect(codes(split.block)).toEqual(['MXIK_CASH_LIMIT']);
    expect(split.block[0]?.lineIds).toEqual(['a1', 'a2']);
    expect(split.block[0]?.details?.['mxik']).toBe(OK_A);
    const two = evaluate(
      {
        lines: [
          line('a', { finalTotalTiyin: LIMIT }),
          line('b', { mxik: OK_B, finalTotalTiyin: LIMIT }),
        ],
      },
      [cash(2n * LIMIT)],
      ctx({ pkg }),
    );
    expect(two.block).toEqual([]);
    const exempt = evaluate(
      { lines: [line('e', { mxik: EXEMPT, finalTotalTiyin: 10n * LIMIT })] },
      [cash(10n * LIMIT)],
      ctx({ pkg }),
    );
    expect(exempt.block).toEqual([]);
    expect(
      evaluate(
        { lines: [line('a', { finalTotalTiyin: 10n * LIMIT })] },
        [card(10n * LIMIT)],
        ctx({ pkg }),
      ).block,
    ).toEqual([]);
  });

  it('property (cash mode): attributed cash never exceeds the cash paid, so cash ≤ limit never blocks', () => {
    const pkg = limitPkg('cash', true);
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 0n, max: 50n * LIMIT }), { minLength: 1, maxLength: 8 }),
        fc.bigInt({ min: 1n, max: LIMIT }),
        (totals, paidCash) => {
          const res = evaluate(
            { lines: totals.map((t, i) => line(`l${String(i)}`, { finalTotalTiyin: t })) },
            [cash(paidCash)],
            ctx({ pkg }),
          );
          expect(codes(res.block)).not.toContain('MXIK_CASH_LIMIT');
        },
      ),
    );
  });
});

describe('@mezon/rules — EXPIRED_GOODS is WARN only (owner S7)', () => {
  const todayStartLocal = 1_762_974_000_000n; // 2025-11-13 00:00 Asia/Tashkent
  const at = (ms: bigint, fiscalMode = false) =>
    ctx({ nowMs: ms, todayDateKey: toDateKey(ms), fiscalMode });
  const exp = (ms: bigint) =>
    line('l1', { batchExpiries: [{ expiryDateMs: ms, qtyMilli: 1000n }] });
  const now = todayStartLocal + 5n * 3_600_000n;

  it('yesterday → warn (never block, also in fiscal mode); today and tomorrow → no finding', () => {
    for (const fiscal of [false, true]) {
      const res = evaluate({ lines: [exp(todayStartLocal - 1n)] }, [cash(1n)], at(now, fiscal));
      expect(res.block.filter((f) => f.code === 'EXPIRED_GOODS')).toEqual([]);
      expect(codes(res.warn)).toContain('EXPIRED_GOODS');
    }
    const today = evaluate({ lines: [exp(todayStartLocal)] }, [cash(1n)], at(now));
    expect(codes(today.warn)).not.toContain('EXPIRED_GOODS');
    const tomorrow = evaluate({ lines: [exp(todayStartLocal + DAY)] }, [cash(1n)], at(now));
    expect(codes(tomorrow.warn)).not.toContain('EXPIRED_GOODS');
  });

  it('local midnight rollover: 23:59:59.999 still today, 00:00 next day warns', () => {
    const lastMsOfDay = todayStartLocal + DAY - 1n;
    expect(
      codes(evaluate({ lines: [exp(todayStartLocal)] }, [], at(lastMsOfDay)).warn),
    ).not.toContain('EXPIRED_GOODS');
    expect(
      codes(evaluate({ lines: [exp(todayStartLocal)] }, [], at(lastMsOfDay + 1n)).warn),
    ).toContain('EXPIRED_GOODS');
  });

  it('one expired leg among several warns for that line only; null expiry ignored; disabled by package', () => {
    const res = evaluate(
      {
        lines: [
          line('fresh', { batchExpiries: [{ expiryDateMs: NOW + DAY, qtyMilli: 500n }] }),
          line('mixed', {
            batchExpiries: [
              { expiryDateMs: NOW + DAY, qtyMilli: 500n },
              { expiryDateMs: NOW - 2n * DAY, qtyMilli: 500n },
              { expiryDateMs: null, qtyMilli: 1n },
            ],
          }),
        ],
      },
      [],
      ctx(),
    );
    const warns = res.warn.filter((f) => f.code === 'EXPIRED_GOODS');
    expect(warns.map((w) => w.lineIds)).toEqual([['mixed']]);
    expect(warns[0]?.details?.['expiryDate']).toBe(toDateKey(NOW - 2n * DAY));
    const disabled = verified(wire({ expiredGoods: { enabled: false } }));
    expect(
      codes(
        evaluate(
          {
            lines: [line('x', { batchExpiries: [{ expiryDateMs: NOW - 9n * DAY, qtyMilli: 1n }] })],
          },
          [],
          ctx({ pkg: disabled }),
        ).warn,
      ),
    ).not.toContain('EXPIRED_GOODS');
  });
});

describe('@mezon/rules — general properties', () => {
  it('MXIK_MISSING warns with the affected line ids', () => {
    const res = evaluate(
      { lines: [line('a', { mxik: null }), line('b'), line('c', { mxik: null })] },
      [],
      ctx(),
    );
    expect(res.warn.find((f) => f.code === 'MXIK_MISSING')?.lineIds).toEqual(['a', 'c']);
  });

  it('T3.3: MXIK_MISSING BLOCKS in fiscal mode (F6) and only warns outside it', () => {
    const cart = { lines: [line('a', { mxik: null }), line('b')] };
    const on = evaluate(cart, [], ctx({ fiscalMode: true }));
    expect(on.block.find((f) => f.code === 'MXIK_MISSING')?.lineIds).toEqual(['a']);
    expect(on.warn.some((f) => f.code === 'MXIK_MISSING')).toBe(false);
    const off = evaluate(cart, [], ctx({ fiscalMode: false }));
    expect(off.block.some((f) => f.code === 'MXIK_MISSING')).toBe(false);
    expect(off.warn.some((f) => f.code === 'MXIK_MISSING')).toBe(true);
  });

  it('property: line order never changes the set of finding codes; cashless receipts are never blocked by a package rule', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            mxik: fc.constantFrom(FORBIDDEN, FORBIDDEN_PREFIXED, OK_A, OK_B, EXEMPT, null),
            total: fc.bigInt({ min: 0n, max: 5n * LIMIT }),
            expired: fc.boolean(),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.constantFrom('cash', 'card', 'uzqr', 'payme', 'other'),
        (spec, method) => {
          const ls = spec.map((s, i) =>
            line(`l${String(i)}`, {
              mxik: s.mxik,
              finalTotalTiyin: s.total,
              batchExpiries: [
                { expiryDateMs: s.expired ? NOW - 3n * DAY : NOW + DAY, qtyMilli: 1n },
              ],
            }),
          );
          const total = spec.reduce((a, s) => a + s.total, 0n);
          const p: RulesPaymentInput = { method, amountTiyin: total > 0n ? total : 1n };
          const a = evaluate({ lines: ls }, [p], ctx());
          const b = evaluate({ lines: [...ls].reverse() }, [p], ctx());
          expect(new Set(codes(a.block))).toEqual(new Set(codes(b.block)));
          expect(new Set(codes(a.warn))).toEqual(new Set(codes(b.warn)));
          if (method !== 'cash') {
            expect(a.block).toEqual([]);
          }
          expect(a.warn.filter((f) => f.code === 'EXPIRED_GOODS')).toHaveLength(
            spec.filter((s) => s.expired).length,
          );
        },
      ),
    );
  });
});
