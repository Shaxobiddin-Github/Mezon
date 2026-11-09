import { calculateTiyinSum, DOMAIN_PACKAGE } from './index.js';

describe('domain package', () => {
  it('exports package name', () => {
    expect(DOMAIN_PACKAGE).toBe('@mezon/domain');
  });

  it('calculates sum of tiyin values in bigint', () => {
    expect(calculateTiyinSum(1000n, 2500n)).toBe(3500n);
  });
});
