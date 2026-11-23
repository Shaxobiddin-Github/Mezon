import { describe, expect, it } from 'vitest';
import { PositiveBigIntStringSchema } from './cart.js';
import { SignedBoundedMoneyStringSchema } from './customer.js';
import {
  BoundedMoneyStringSchema,
  CompleteSaleRequestSchema,
  PositiveBoundedMoneyStringSchema,
} from './sale.js';

/** A malformed number must be a validation issue (HTTP 400), never a thrown BigInt error (500). */
describe('integer string schemas reject garbage without throwing', () => {
  const garbage = ['undefined', 'abc', '', '1.5', '1e3', ' 12', '-'];
  const schemas = {
    PositiveBigIntStringSchema,
    BoundedMoneyStringSchema,
    PositiveBoundedMoneyStringSchema,
    SignedBoundedMoneyStringSchema,
  };
  for (const [name, schema] of Object.entries(schemas)) {
    it(name, () => {
      for (const value of garbage) {
        expect(() => schema.safeParse(value)).not.toThrow();
        expect(schema.safeParse(value).success).toBe(false);
      }
    });
  }

  it('CompleteSaleRequestSchema reports a bad expectedTotal as an issue', () => {
    const res = CompleteSaleRequestSchema.safeParse({
      clientRequestId: '01a201ae-1f71-731c-a2e5-e83ac758567f',
      expectedTotal: 'undefined',
      payments: [{ method: 'cash', tenderedAmount: 'abc' }],
    });
    expect(res.success).toBe(false);
  });

  it('still accepts valid values', () => {
    expect(PositiveBigIntStringSchema.safeParse('1000').success).toBe(true);
    expect(BoundedMoneyStringSchema.safeParse('0').success).toBe(true);
    expect(SignedBoundedMoneyStringSchema.safeParse('-500').success).toBe(true);
  });
});
