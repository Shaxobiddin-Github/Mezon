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
  parseRulesEnvelope,
  parseRulesPayload,
  resolveRulesPackageState,
  rulesPayloadToWire,
  verifyRulesPackage,
} from './index.js';

/**
 * T3.2a pure tests. Real Ed25519 is exercised in the hub (`apps/hub/src/rules.test.ts`); here a
 * deterministic TEST verifier (signature = base64 of a 64-byte digest-free echo) checks the flow.
 * All MXIK values are SYNTHETIC (`999…`), never real rule data.
 */

const DAY = 86_400_000n;
const NOW = 1_763_000_000_000n; // 2025-11-13T02:13:20Z → Tashkent 07:13 same date
const tz = 'Asia/Tashkent';
const toDateKey = (ms: bigint) => getBusinessDateKey(unixMsFromBigInt(ms), tz);

const BASE_WIRE = {
  packageVersion: '3',
  issuedAtMs: (NOW - DAY).toString(),
  validUntilMs: (NOW + 30n * DAY).toString(),
  sourceRefs: ['SINTETIK-TEST'],
  cashForbidden: { exact: ['99900000000000001'], prefixes: ['9991'] },
  prescriptionRequired: { exact: [], prefixes: [] },
  perMxikCashLimit: { limitTiyin: '2500000000', exempt: { exact: [], prefixes: [] } },
  socialCard: { enabled: true },
  expiredGoods: { enabled: true },
};

/** TEST-ONLY verifier: accepts iff signature equals the pseudo-signature of the message. */
function pseudoSig(message: string, secret: string): string {
  let h = 0n;
  for (const ch of `${secret}|${message}`)
    h = (h * 131n + BigInt(ch.codePointAt(0) ?? 0)) % (1n << 255n);
  const hex = h.toString(16).padStart(128, '0').slice(-128);
  // Map hex digits onto the base64 alphabet: 86 chars + '==' matches the 64-byte signature shape.
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

function signWire(wire: typeof BASE_WIRE, key: TrustedRuleKey, keyIdInEnvelope = key.keyId) {
  const payload = parseRulesPayload(wire);
  return {
    format: 'mezon-rules',
    formatVersion: 1,
    keyId: keyIdInEnvelope,
    payload: wire,
    signature: pseudoSig(buildRulesSigningMessage(key.keyId, payload), key.publicKeyB64),
  };
}

function verified(wire = BASE_WIRE): VerifiedRulesPackage {
  return verifyRulesPackage(signWire(wire, KEY_A), [KEY_A], testVerifier);
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
    mxik: '10101001001000001',
    qtyMilli: 1000n,
    finalTotalTiyin: 100_000n,
    batchExpiries: [],
    ...over,
  };
}

const CASH: RulesPaymentInput = { method: 'cash', amountTiyin: 100_000n, socialCard: null };
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

describe('@mezon/rules — package parsing (strict)', () => {
  it('round-trips wire → typed → wire exactly', () => {
    expect(rulesPayloadToWire(parseRulesPayload(BASE_WIRE))).toEqual(BASE_WIRE);
  });

  it('rejects unknown/missing fields, non-canonical numbers, bad ranges and unnormalized MXIK', () => {
    const bad: unknown[] = [
      { ...BASE_WIRE, extra: 1 },
      (() => {
        const { socialCard: _s, ...rest } = BASE_WIRE;
        return rest;
      })(),
      { ...BASE_WIRE, packageVersion: '03' },
      { ...BASE_WIRE, packageVersion: 3 },
      { ...BASE_WIRE, packageVersion: '0' },
      { ...BASE_WIRE, validUntilMs: BASE_WIRE.issuedAtMs },
      { ...BASE_WIRE, cashForbidden: { exact: [' 999'], prefixes: [] } },
      { ...BASE_WIRE, cashForbidden: { exact: ['999 000'], prefixes: [] } },
      { ...BASE_WIRE, perMxikCashLimit: { limitTiyin: '-1', exempt: { exact: [], prefixes: [] } } },
    ];
    for (const b of bad) {
      expect(() => parseRulesPayload(b), JSON.stringify(b)).toThrow(DomainError);
    }
    expect(() => parseRulesEnvelope({ ...signWire(BASE_WIRE, KEY_A), signature: 'short' })).toThrow(
      DomainError,
    );
    expect(() => parseRulesEnvelope({ ...signWire(BASE_WIRE, KEY_A), formatVersion: 2 })).toThrow(
      DomainError,
    );
  });
});

describe('@mezon/rules — verification flow', () => {
  it('signed message has the domain prefix and includes keyId', () => {
    const msg = buildRulesSigningMessage('test-a', parseRulesPayload(BASE_WIRE));
    expect(msg.startsWith(RULES_SIGNING_PREFIX)).toBe(true);
    expect(msg).toContain('"keyId":"test-a"');
  });

  it('accepts a correctly signed package; rejects untrusted key, wrong key, swapped keyId, tampered payload', () => {
    expect(verified().payload.packageVersion).toBe(3n);
    expect(() => verifyRulesPackage(signWire(BASE_WIRE, KEY_A), [KEY_B], testVerifier)).toThrow(
      /RULES_KEY_UNTRUSTED|Unknown rules key/,
    );
    // Signed by B, envelope claims A (trusted): signature invalid
    expect(() =>
      verifyRulesPackage(signWire(BASE_WIRE, KEY_B, 'test-a'), [KEY_A, KEY_B], testVerifier),
    ).toThrow(/signature/);
    const tampered = {
      ...signWire(BASE_WIRE, KEY_A),
      payload: { ...BASE_WIRE, packageVersion: '4' },
    };
    expect(() => verifyRulesPackage(tampered, [KEY_A], testVerifier)).toThrow(/signature/);
  });

  it('enforces the key validity window at issue time (rotation)', () => {
    const expiredKey = { ...KEY_A, validUntilMs: NOW - 2n * DAY };
    expect(() =>
      verifyRulesPackage(signWire(BASE_WIRE, KEY_A), [expiredKey], testVerifier),
    ).toThrow(/not valid at package issue time/);
    const futureKey = { ...KEY_A, validFromMs: NOW };
    expect(() => verifyRulesPackage(signWire(BASE_WIRE, KEY_A), [futureKey], testVerifier)).toThrow(
      /not valid at package issue time/,
    );
  });

  it('a verifier that throws is treated as an invalid signature', () => {
    const throwing: RulesSignatureVerifier = {
      verifyEd25519: () => {
        throw new Error('boom');
      },
    };
    expect(() => verifyRulesPackage(signWire(BASE_WIRE, KEY_A), [KEY_A], throwing)).toThrow(
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

describe('@mezon/rules — evaluate (T3.2a)', () => {
  it('§8 package states: missing/invalid warn when fiscal off, block when on; expired warns', () => {
    for (const state of ['missing', 'invalid'] as const) {
      const code = state === 'missing' ? 'PACKAGE_MISSING' : 'PACKAGE_INVALID';
      const off = evaluate({ lines: [line('l1')] }, [CASH], ctx({ pkg: null, pkgState: state }));
      expect(codes(off.warn)).toContain(code);
      expect(off.block).toEqual([]);
      const on = evaluate(
        { lines: [line('l1')] },
        [CASH],
        ctx({ pkg: null, pkgState: state, fiscalMode: true }),
      );
      expect(codes(on.block)).toEqual([code]);
    }
    const expired = evaluate({ lines: [line('l1')] }, [CASH], ctx({ pkgState: 'expired' }));
    expect(codes(expired.warn)).toContain('PACKAGE_EXPIRED');
    expect(expired.block).toEqual([]);
    expect(expired.packageVersion).toBe('3');
  });

  it('SOCIAL_CARD_DATA_REQUIRED: every missing/blank/too-long field blocks; complete data passes', () => {
    const ok = { cardType: 'TIP-1', cardNumber: '12345678', transactionId: 'TX-1' };
    const sc = (socialCard: RulesPaymentInput['socialCard']): RulesPaymentInput => ({
      method: 'social_card',
      amountTiyin: 100_000n,
      socialCard,
    });
    expect(evaluate({ lines: [line('l1')] }, [sc(ok)], ctx()).block).toEqual([]);
    const bad = [
      null,
      { ...ok, cardType: '' },
      { ...ok, cardType: '   ' },
      { ...ok, cardNumber: '123' },
      { ...ok, cardNumber: 'x'.repeat(33) },
      { ...ok, transactionId: '' },
      { ...ok, transactionId: 'x'.repeat(129) },
      { ...ok, cardType: 'x'.repeat(65) },
    ];
    for (const card of bad) {
      const res = evaluate({ lines: [line('l1')] }, [CASH, sc(card)], ctx());
      expect(codes(res.block), JSON.stringify(card)).toEqual(['SOCIAL_CARD_DATA_REQUIRED']);
      expect(res.block[0]?.details?.['paymentIndex']).toBe('1');
    }
    // Package-independent: still enforced without a package
    expect(codes(evaluate({ lines: [] }, [sc(null)], ctx({ pkg: null })).block)).toContain(
      'SOCIAL_CARD_DATA_REQUIRED',
    );
    // Disabled by a signed package
    const disabled = verified({ ...BASE_WIRE, socialCard: { enabled: false } });
    expect(evaluate({ lines: [] }, [sc(null)], ctx({ pkg: disabled })).block).toEqual([]);
  });

  it('EXPIRED_GOODS: store-local date boundary — yesterday blocks, today and tomorrow pass', () => {
    // Tashkent is UTC+5: 18:59:59.999Z = 23:59:59.999 local; 19:00:00Z = 00:00 next day.
    const todayStartLocal = 1_762_974_000_000n; // 2025-11-13 00:00 Tashkent
    const at = (ms: bigint) => ctx({ nowMs: ms, todayDateKey: toDateKey(ms) });
    const exp = (ms: bigint) =>
      line('l1', { batchExpiries: [{ expiryDateMs: ms, qtyMilli: 1000n }] });
    const now = todayStartLocal + 5n * 3_600_000n;
    expect(codes(evaluate({ lines: [exp(todayStartLocal - 1n)] }, [CASH], at(now)).block)).toEqual([
      'EXPIRED_GOODS',
    ]);
    expect(evaluate({ lines: [exp(todayStartLocal)] }, [CASH], at(now)).block).toEqual([]);
    expect(evaluate({ lines: [exp(todayStartLocal + DAY)] }, [CASH], at(now)).block).toEqual([]);
    // Midnight rollover: an item expiring "today" becomes expired one ms after local midnight
    const lastMsOfDay = todayStartLocal + DAY - 1n;
    expect(evaluate({ lines: [exp(todayStartLocal)] }, [CASH], at(lastMsOfDay)).block).toEqual([]);
    expect(
      codes(evaluate({ lines: [exp(todayStartLocal)] }, [CASH], at(lastMsOfDay + 1n)).block),
    ).toEqual(['EXPIRED_GOODS']);
  });

  it('EXPIRED_GOODS: one expired leg among several blocks that line only; null expiry ignored; preview has no legs', () => {
    const now = NOW;
    const res = evaluate(
      {
        lines: [
          line('fresh', { batchExpiries: [{ expiryDateMs: now + DAY, qtyMilli: 500n }] }),
          line('mixed', {
            batchExpiries: [
              { expiryDateMs: now + DAY, qtyMilli: 500n },
              { expiryDateMs: now - 2n * DAY, qtyMilli: 500n },
              { expiryDateMs: null, qtyMilli: 1n },
            ],
          }),
        ],
      },
      [CASH],
      ctx(),
    );
    expect(res.block).toHaveLength(1);
    expect(res.block[0]?.lineIds).toEqual(['mixed']);
    expect(res.block[0]?.details?.['expiryDate']).toBe(toDateKey(now - 2n * DAY));
    const disabled = verified({ ...BASE_WIRE, expiredGoods: { enabled: false } });
    expect(
      evaluate(
        { lines: [line('x', { batchExpiries: [{ expiryDateMs: now - 9n * DAY, qtyMilli: 1n }] })] },
        [CASH],
        ctx({ pkg: disabled }),
      ).block,
    ).toEqual([]);
  });

  it('MXIK_MISSING warns with the affected line ids', () => {
    const res = evaluate(
      { lines: [line('a', { mxik: null }), line('b'), line('c', { mxik: null })] },
      [],
      ctx(),
    );
    expect(res.warn.find((f) => f.code === 'MXIK_MISSING')?.lineIds).toEqual(['a', 'c']);
  });

  it('T3.2b codes are reserved but NEVER produced yet (cash ban / limit / prescription)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            mxik: fc.constantFrom(
              '99900000000000001',
              '99910000000000000',
              '10101001001000001',
              null,
            ),
            total: fc.bigInt({ min: 1n, max: 10_000_000_000n }),
          }),
          { maxLength: 6 },
        ),
        fc.bigInt({ min: 1n, max: 10_000_000_000n }),
        (lines, cash) => {
          const res = evaluate(
            {
              lines: lines.map((l, i) =>
                line(`l${String(i)}`, { mxik: l.mxik, finalTotalTiyin: l.total }),
              ),
            },
            [{ method: 'cash', amountTiyin: cash, socialCard: null }],
            ctx(),
          );
          const all = [...codes(res.block), ...codes(res.warn)];
          for (const c of [
            'CASH_FORBIDDEN_MXIK',
            'MIXED_RECEIPT_CASHLESS',
            'MXIK_CASH_LIMIT',
            'PRESCRIPTION_REQUIRED',
          ]) {
            expect(all).not.toContain(c);
          }
        },
      ),
    );
  });

  it('property: line order does not change the set of finding codes; non-social payments never trigger SOCIAL_CARD', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            expired: fc.boolean(),
            mxik: fc.option(fc.constant('10101001001000001'), { nil: null }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.constantFrom('cash', 'card', 'uzqr', 'payme', 'other'),
        (spec, method) => {
          const ls = spec.map((s, i) =>
            line(`l${String(i)}`, {
              mxik: s.mxik,
              batchExpiries: [
                { expiryDateMs: s.expired ? NOW - 3n * DAY : NOW + DAY, qtyMilli: 1n },
              ],
            }),
          );
          const p: RulesPaymentInput = { method, amountTiyin: 1n, socialCard: null };
          const a = evaluate({ lines: ls }, [p], ctx());
          const b = evaluate({ lines: [...ls].reverse() }, [p], ctx());
          expect(new Set(codes(a.block))).toEqual(new Set(codes(b.block)));
          expect(codes(a.block)).not.toContain('SOCIAL_CARD_DATA_REQUIRED');
          expect(a.block.filter((f) => f.code === 'EXPIRED_GOODS')).toHaveLength(
            spec.filter((s) => s.expired).length,
          );
        },
      ),
    );
  });
});
