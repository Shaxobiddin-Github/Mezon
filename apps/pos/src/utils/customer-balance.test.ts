import { describe, expect, it } from 'vitest';
import { customerBalanceLabel } from './customer-balance.js';

describe('P1/S6 customerBalanceLabel', () => {
  it('a debt is shown as debt, an overpayment as the customer’s credit (never "-X")', () => {
    expect(customerBalanceLabel('1500000')).toMatch(/^Joriy qarz: 15[\s ,.]?000/);
    const over = customerBalanceLabel('-1000000');
    expect(over).toMatch(/^Ortiqcha toʻlov: 10[\s ,.]?000/);
    expect(over).toContain('mijoz haqqi');
    expect(over).not.toContain('-');
    expect(customerBalanceLabel('0')).toMatch(/^Joriy qarz: 0/);
  });
});
