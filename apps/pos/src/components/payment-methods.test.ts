import { describe, expect, it } from 'vitest';
import { NON_CASH_METHODS } from './PaymentAndShiftModals.js';

describe('@mezon/pos - v1 payment methods', () => {
  it('UzQR is not offered as a manual method (it needs a provider-confirmed QR since T3.6)', () => {
    expect(NON_CASH_METHODS).not.toContain('uzqr');
    expect(NON_CASH_METHODS).toContain('card');
  });
});
