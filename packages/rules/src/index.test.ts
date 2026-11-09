import { RULES_PACKAGE, isDomainAvailable } from './index.js';

describe('rules package', () => {
  it('exports package name', () => {
    expect(RULES_PACKAGE).toBe('@mezon/rules');
  });

  it('verifies domain availability via import', () => {
    expect(isDomainAvailable()).toBe(true);
  });
});
