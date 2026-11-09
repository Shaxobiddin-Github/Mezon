import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DomainError,
  ZERO_MONEY,
  moneyFromTiyin,
  moneyToTiyin,
  addMoney,
  subtractMoney,
  negateMoney,
  sumMoney,
  type Money,
  ZERO_QUANTITY,
  quantityFromMilli,
  quantityToMilli,
  addQuantity,
  subtractQuantity,
  negateQuantity,
  type Quantity,
  divideRoundHalfAwayFromZero,
  multiply,
  allocate,
  ZERO_VAT_RATE,
  vatRateFromBasisPoints,
  vatRateToBasisPoints,
  calculateVatExcluded,
  calculateVatIncluded,
  type VatRate,
  serializeMoney,
  parseMoney,
  serializeQuantity,
  parseQuantity,
  formatMoneyDecimal,
  parseMoneyDecimal,
  formatQuantityDecimal,
  parseQuantityDecimal,
} from './index.js';

describe('@mezon/domain - Money and Quantity basic operations', () => {
  it('handles basic money operations correctly', () => {
    const m1 = moneyFromTiyin(15000n);
    const m2 = moneyFromTiyin(2500n);

    expect(moneyToTiyin(m1)).toBe(15000n);
    expect(moneyToTiyin(ZERO_MONEY)).toBe(0n);
    expect(moneyToTiyin(addMoney(m1, m2))).toBe(17500n);
    expect(moneyToTiyin(subtractMoney(m1, m2))).toBe(12500n);
    expect(moneyToTiyin(negateMoney(m1))).toBe(-15000n);
    expect(moneyToTiyin(sumMoney([m1, m2, negateMoney(m2)]))).toBe(15000n);
  });

  it('handles basic quantity operations correctly', () => {
    const q1 = quantityFromMilli(5500n);
    const q2 = quantityFromMilli(1200n);

    expect(quantityToMilli(q1)).toBe(5500n);
    expect(quantityToMilli(ZERO_QUANTITY)).toBe(0n);
    expect(quantityToMilli(addQuantity(q1, q2))).toBe(6700n);
    expect(quantityToMilli(subtractQuantity(q1, q2))).toBe(4300n);
    expect(quantityToMilli(negateQuantity(q1))).toBe(-5500n);
  });
});

describe('@mezon/domain - Rounding and multiply', () => {
  it('matches exact rounding examples specified in requirements', () => {
    // 1234567n Money * 5500n Quantity = 6790119n Money
    const m = moneyFromTiyin(1234567n);
    const q = quantityFromMilli(5500n);
    expect(moneyToTiyin(multiply(m, q))).toBe(6790119n);

    // 1n * 500n = 1n
    expect(moneyToTiyin(multiply(moneyFromTiyin(1n), quantityFromMilli(500n)))).toBe(1n);

    // -1n * 500n = -1n
    expect(moneyToTiyin(multiply(moneyFromTiyin(-1n), quantityFromMilli(500n)))).toBe(-1n);

    // 1n * 499n = 0n
    expect(moneyToTiyin(multiply(moneyFromTiyin(1n), quantityFromMilli(499n)))).toBe(0n);
  });

  it('verifies divideRoundHalfAwayFromZero denominator validation', () => {
    expect(() => divideRoundHalfAwayFromZero(100n, 0n)).toThrowError(DomainError);
    expect(() => divideRoundHalfAwayFromZero(100n, -10n)).toThrowError(DomainError);
  });

  it('verifies multiply identity and zero with fast-check', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -100_000_000_000n, max: 100_000_000_000n }), (rawM) => {
        const m = moneyFromTiyin(rawM);
        const thousandQ = quantityFromMilli(1000n);
        const zeroQ = quantityFromMilli(0n);

        expect(moneyToTiyin(multiply(m, thousandQ))).toBe(rawM);
        expect(moneyToTiyin(multiply(m, zeroQ))).toBe(0n);
      }),
    );
  });

  it('verifies sign symmetry across both arguments with fast-check', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1_000_000_000n, max: 1_000_000_000n }),
        fc.bigInt({ min: -1_000_000_000n, max: 1_000_000_000n }),
        (rawM, rawQ) => {
          const m = moneyFromTiyin(rawM);
          const q = quantityFromMilli(rawQ);

          const res = moneyToTiyin(multiply(m, q));
          const resNegM = moneyToTiyin(multiply(negateMoney(m), q));
          const resNegQ = moneyToTiyin(multiply(m, negateQuantity(q)));

          expect(resNegM).toBe(-res);
          expect(resNegQ).toBe(-res);
        },
      ),
    );
  });

  it('verifies error bound |result * 1000 - m * q| <= 500 with fast-check', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }),
        fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }),
        (rawM, rawQ) => {
          const res = moneyToTiyin(multiply(moneyFromTiyin(rawM), quantityFromMilli(rawQ)));
          const exactProduct = rawM * rawQ;
          const diff = res * 1000n - exactProduct;
          const absDiff = diff < 0n ? -diff : diff;
          expect(absDiff <= 500n).toBe(true);
        },
      ),
    );
  });
});

describe('@mezon/domain - allocate (Largest Remainder Method)', () => {
  it('matches exact allocation test cases', () => {
    // allocate(10n, [0n, 1n]) === [0n, 10n]
    const res1 = allocate(moneyFromTiyin(10n), [0n, 1n]);
    expect(res1.map(moneyToTiyin)).toEqual([0n, 10n]);

    // allocate(-5n, [1n, 1n]) === [-3n, -2n]
    const res2 = allocate(moneyFromTiyin(-5n), [1n, 1n]);
    expect(res2.map(moneyToTiyin)).toEqual([-3n, -2n]);

    // 1 tiyin across 3 equal weights
    const res3 = allocate(moneyFromTiyin(1n), [1n, 1n, 1n]);
    expect(res3.map(moneyToTiyin)).toEqual([1n, 0n, 0n]);

    // zero money
    const resZero = allocate(moneyFromTiyin(0n), [2n, 3n]);
    expect(resZero.map(moneyToTiyin)).toEqual([0n, 0n]);
  });

  it('throws DomainError on invalid weights', () => {
    // empty weights
    expect(() => allocate(moneyFromTiyin(100n), [])).toThrowError(
      new DomainError('ALLOCATE_EMPTY_WEIGHTS'),
    );

    // negative weight
    expect(() => allocate(moneyFromTiyin(100n), [1n, -2n])).toThrowError(
      new DomainError('ALLOCATE_NEGATIVE_WEIGHT'),
    );

    // zero total weight
    expect(() => allocate(moneyFromTiyin(100n), [0n, 0n])).toThrowError(
      new DomainError('ALLOCATE_ZERO_TOTAL_WEIGHT'),
    );
  });

  it('verifies allocate properties with fast-check', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }),
        fc.array(fc.bigInt({ min: 0n, max: 100_000n }), { minLength: 1, maxLength: 20 }),
        (rawMoney, rawWeights) => {
          const totalW = rawWeights.reduce((a, b) => a + b, 0n);
          if (totalW === 0n) return; // skip degenerate zero total weight

          const money = moneyFromTiyin(rawMoney);
          const allocated = allocate(money, rawWeights);

          // 1. Sum invariant: sum(allocated) === totalMoney exactly
          const sumAllocated = allocated.reduce((a, b) => a + moneyToTiyin(b), 0n);
          expect(sumAllocated).toBe(rawMoney);

          // 2. Sign symmetry: allocate(-m, w) element-wise === -allocate(m, w)
          const negAllocated = allocate(negateMoney(money), rawWeights);
          for (let i = 0; i < allocated.length; i++) {
            expect(moneyToTiyin(negAllocated[i])).toBe(-moneyToTiyin(allocated[i]));
          }

          // 3. Mathematical bound: |share * T - M * w| < T
          const absM = rawMoney < 0n ? -rawMoney : rawMoney;
          for (let i = 0; i < allocated.length; i++) {
            const rawShare = moneyToTiyin(allocated[i]);
            const absShare = rawShare < 0n ? -rawShare : rawShare;
            const diff = absShare * totalW - absM * rawWeights[i];
            const absDiff = diff < 0n ? -diff : diff;
            expect(absDiff < totalW).toBe(true);
          }

          // 4. Determinism: identical inputs produce identical outputs
          const repeat = allocate(money, rawWeights);
          expect(repeat.map(moneyToTiyin)).toEqual(allocated.map(moneyToTiyin));
        },
      ),
    );
  });
});

describe('@mezon/domain - VatRate and VAT calculations', () => {
  it('validates VatRate basis points range', () => {
    expect(vatRateToBasisPoints(ZERO_VAT_RATE)).toBe(0n);
    expect(vatRateToBasisPoints(vatRateFromBasisPoints(1200n))).toBe(1200n);
    expect(vatRateToBasisPoints(vatRateFromBasisPoints(10000n))).toBe(10000n);

    expect(() => vatRateFromBasisPoints(-1n)).toThrowError(new DomainError('INVALID_VAT_RATE'));
    expect(() => vatRateFromBasisPoints(10001n)).toThrowError(new DomainError('INVALID_VAT_RATE'));
  });

  it('matches exact VAT calculations for 12%', () => {
    const rate12 = vatRateFromBasisPoints(1200n);

    // 11200000n gross, 12% -> vat 1200000n, net 10000000n
    const gross = moneyFromTiyin(11200000n);
    const inc = calculateVatIncluded(gross, rate12);
    expect(moneyToTiyin(inc.vat)).toBe(1200000n);
    expect(moneyToTiyin(inc.net)).toBe(10000000n);

    // Excluded calculation: net 10000000n -> vat 1200000n, total 11200000n
    const exc = calculateVatExcluded(inc.net, rate12);
    expect(moneyToTiyin(exc.vat)).toBe(1200000n);
    expect(moneyToTiyin(exc.total)).toBe(11200000n);

    // 0n rate
    const incZero = calculateVatIncluded(gross, ZERO_VAT_RATE);
    expect(moneyToTiyin(incZero.vat)).toBe(0n);
    expect(moneyToTiyin(incZero.net)).toBe(11200000n);
  });

  it('verifies VAT invariants and sign symmetry with fast-check', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }),
        fc.bigInt({ min: 0n, max: 10000n }),
        (rawGross, rawRate) => {
          const gross = moneyFromTiyin(rawGross);
          const rate = vatRateFromBasisPoints(rawRate);

          const { net, vat } = calculateVatIncluded(gross, rate);

          // Invariant: net + vat === gross
          expect(moneyToTiyin(addMoney(net, vat))).toBe(rawGross);

          // Sign symmetry
          const negGross = negateMoney(gross);
          const negResult = calculateVatIncluded(negGross, rate);
          expect(moneyToTiyin(negResult.vat)).toBe(-moneyToTiyin(vat));
          expect(moneyToTiyin(negResult.net)).toBe(-moneyToTiyin(net));
        },
      ),
    );
  });
});

describe('@mezon/domain - Serialization and Decimal Parsing', () => {
  it('parses and formats classic sign and edge cases', () => {
    // parseMoneyDecimal("-0.50") === -50n
    expect(moneyToTiyin(parseMoneyDecimal('-0.50'))).toBe(-50n);

    // formatMoneyDecimal(-50n) === "-0.50"
    expect(formatMoneyDecimal(moneyFromTiyin(-50n))).toBe('-0.50');

    // formatMoneyDecimal(5n) === "0.05"
    expect(formatMoneyDecimal(moneyFromTiyin(5n))).toBe('0.05');

    // formatQuantityDecimal(-500n) === "-0.500"
    expect(formatQuantityDecimal(quantityFromMilli(-500n))).toBe('-0.500');

    // parseQuantityDecimal
    expect(quantityToMilli(parseQuantityDecimal('-0.500'))).toBe(-500n);
    expect(quantityToMilli(parseQuantityDecimal('5.5'))).toBe(5500n);
    expect(quantityToMilli(parseQuantityDecimal('0.001'))).toBe(1n);
  });

  it('strictly rejects non-canonical and malformed inputs', () => {
    const invalidInputs = [
      '-0',
      '007',
      '+1',
      '12,5',
      '.5',
      '5.',
      '',
      '   ',
      'abc',
      '12.345', // > 2 decimals for money
      '1'.repeat(31), // > 30 chars
    ];

    for (const bad of invalidInputs) {
      expect(() => parseMoneyDecimal(bad)).toThrowError(DomainError);
    }

    const invalidInts = ['-0', '007', '+1', '12.5', ''];
    for (const bad of invalidInts) {
      expect(() => parseMoney(bad)).toThrowError(DomainError);
      expect(() => parseQuantity(bad)).toThrowError(DomainError);
    }
  });

  it('verifies roundtrip serialization with fast-check', () => {
    // Money canonical integer serialization roundtrip
    fc.assert(
      fc.property(fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }), (rawM) => {
        const m = moneyFromTiyin(rawM);
        const serialized = serializeMoney(m);
        expect(moneyToTiyin(parseMoney(serialized))).toBe(rawM);
      }),
    );

    // Money decimal format roundtrip
    fc.assert(
      fc.property(fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }), (rawM) => {
        const m = moneyFromTiyin(rawM);
        const formatted = formatMoneyDecimal(m);
        expect(moneyToTiyin(parseMoneyDecimal(formatted))).toBe(rawM);
      }),
    );

    // Quantity canonical integer serialization roundtrip
    fc.assert(
      fc.property(fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }), (rawQ) => {
        const q = quantityFromMilli(rawQ);
        const serialized = serializeQuantity(q);
        expect(quantityToMilli(parseQuantity(serialized))).toBe(rawQ);
      }),
    );

    // Quantity decimal format roundtrip
    fc.assert(
      fc.property(fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }), (rawQ) => {
        const q = quantityFromMilli(rawQ);
        const formatted = formatQuantityDecimal(q);
        expect(quantityToMilli(parseQuantityDecimal(formatted))).toBe(rawQ);
      }),
    );
  });
});

describe('@mezon/domain - Compile-time branded type tests (@ts-expect-error)', () => {
  it('enforces branded types at compile time', () => {
    function _compileTimeTypeAssertions() {
      const money = moneyFromTiyin(100n);
      const quantity = quantityFromMilli(1000n);
      const vatRate = vatRateFromBasisPoints(1200n);

      // @ts-expect-error Money and Quantity cannot be added together
      addMoney(money, quantity);

      // @ts-expect-error Money and number cannot be mixed
      addMoney(money, 500);

      // @ts-expect-error Quantity and number cannot be mixed
      addQuantity(quantity, 500);

      // @ts-expect-error Plain bigint cannot be passed to Money parameter without constructor
      addMoney(100n, 200n);

      // @ts-expect-error Plain bigint cannot be passed to Quantity parameter without constructor
      addQuantity(100n, 200n);

      // @ts-expect-error Plain bigint cannot be passed to VatRate parameter without constructor
      calculateVatExcluded(money, 1200n);

      // @ts-expect-error VatRate cannot be passed as Money
      addMoney(money, vatRate);

      // @ts-expect-error Money cannot be assigned to Quantity
      const _invalidAssignment: Quantity = money;
      void _invalidAssignment;

      // @ts-expect-error Quantity cannot be assigned to Money
      const _invalidMoney: Money = quantity;
      void _invalidMoney;

      // @ts-expect-error Money cannot be assigned to VatRate
      const _invalidVatRate: VatRate = money;
      void _invalidVatRate;
    }

    expect(typeof _compileTimeTypeAssertions).toBe('function');
  });
});
