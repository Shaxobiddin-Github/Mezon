import { describe, expect, it } from 'vitest';
import {
  DomainError,
  PIN_SECURITY_CONSTANTS,
  USER_ROLES,
  computeDeviceCooldownDelayMs,
  computeRetryAfterSeconds,
  isUserRole,
  normalizeUsername,
  roleHasPermission,
  validateFullName,
  validatePinFormat,
} from './index.js';

describe('@mezon/domain - auth rules, RBAC, and PIN security policy', () => {
  it('enforces strict role permissions matrix across owner, manager, and cashier', () => {
    expect(USER_ROLES).toEqual(['owner', 'manager', 'cashier']);
    expect(isUserRole('owner')).toBe(true);
    expect(isUserRole('manager')).toBe(true);
    expect(isUserRole('cashier')).toBe(true);
    expect(isUserRole('admin')).toBe(false);

    expect(roleHasPermission('owner', 'auth:self')).toBe(true);
    expect(roleHasPermission('owner', 'users:read')).toBe(true);
    expect(roleHasPermission('owner', 'users:write')).toBe(true);
    expect(roleHasPermission('owner', 'users:unlock')).toBe(true);
    expect(roleHasPermission('owner', 'catalog:read')).toBe(true);
    expect(roleHasPermission('owner', 'catalog:write')).toBe(true);
    expect(roleHasPermission('owner', 'stock:read')).toBe(true);
    expect(roleHasPermission('owner', 'stock:write')).toBe(true);
    expect(roleHasPermission('owner', 'cart:write')).toBe(true);
    expect(roleHasPermission('owner', 'promotions:read')).toBe(true);
    expect(roleHasPermission('owner', 'promotions:write')).toBe(true);
    expect(roleHasPermission('owner', 'discounts:config')).toBe(true);
    expect(roleHasPermission('owner', 'sale:void')).toBe(true);
    expect(roleHasPermission('owner', 'sale:return')).toBe(true);
    expect(roleHasPermission('owner', 'reports:profit')).toBe(true);
    expect(roleHasPermission('owner', 'customers:read')).toBe(true);
    expect(roleHasPermission('owner', 'customers:write')).toBe(true);
    expect(roleHasPermission('owner', 'debt:pay')).toBe(true);
    expect(roleHasPermission('owner', 'debt:manage')).toBe(true);
    expect(roleHasPermission('owner', 'suppliers:read')).toBe(true);
    expect(roleHasPermission('owner', 'suppliers:write')).toBe(true);
    expect(roleHasPermission('owner', 'receiving:read')).toBe(true);
    expect(roleHasPermission('owner', 'receiving:write')).toBe(true);
    expect(roleHasPermission('owner', 'supplier_debt:pay')).toBe(true);
    expect(roleHasPermission('owner', 'supplier_debt:manage')).toBe(true);
    expect(roleHasPermission('owner', 'shifts:read')).toBe(true);
    expect(roleHasPermission('owner', 'shifts:open')).toBe(true);
    expect(roleHasPermission('owner', 'shifts:close')).toBe(true);
    expect(roleHasPermission('owner', 'shifts:reclose')).toBe(true);
    expect(roleHasPermission('owner', 'shifts:cash_move')).toBe(true);
    expect(roleHasPermission('owner', 'day_close:execute')).toBe(true);

    expect(roleHasPermission('manager', 'auth:self')).toBe(true);
    expect(roleHasPermission('manager', 'users:read')).toBe(true);
    expect(roleHasPermission('manager', 'users:unlock')).toBe(true);
    expect(roleHasPermission('manager', 'users:write')).toBe(false);
    expect(roleHasPermission('manager', 'catalog:read')).toBe(true);
    expect(roleHasPermission('manager', 'catalog:write')).toBe(true);
    expect(roleHasPermission('manager', 'stock:read')).toBe(true);
    expect(roleHasPermission('manager', 'stock:write')).toBe(true);
    expect(roleHasPermission('manager', 'cart:write')).toBe(true);
    expect(roleHasPermission('manager', 'promotions:read')).toBe(true);
    expect(roleHasPermission('manager', 'promotions:write')).toBe(true);
    expect(roleHasPermission('manager', 'discounts:config')).toBe(false);
    expect(roleHasPermission('manager', 'sale:void')).toBe(true);
    expect(roleHasPermission('manager', 'sale:return')).toBe(true);
    expect(roleHasPermission('manager', 'reports:profit')).toBe(false);
    expect(roleHasPermission('manager', 'customers:read')).toBe(true);
    expect(roleHasPermission('manager', 'customers:write')).toBe(true);
    expect(roleHasPermission('manager', 'debt:pay')).toBe(true);
    expect(roleHasPermission('manager', 'debt:manage')).toBe(true);
    expect(roleHasPermission('manager', 'suppliers:read')).toBe(true);
    expect(roleHasPermission('manager', 'suppliers:write')).toBe(true);
    expect(roleHasPermission('manager', 'receiving:read')).toBe(true);
    expect(roleHasPermission('manager', 'receiving:write')).toBe(true);
    expect(roleHasPermission('manager', 'supplier_debt:pay')).toBe(true);
    expect(roleHasPermission('manager', 'supplier_debt:manage')).toBe(true);
    expect(roleHasPermission('manager', 'shifts:read')).toBe(true);
    expect(roleHasPermission('manager', 'shifts:open')).toBe(true);
    expect(roleHasPermission('manager', 'shifts:close')).toBe(true);
    expect(roleHasPermission('manager', 'shifts:reclose')).toBe(true);
    expect(roleHasPermission('manager', 'shifts:cash_move')).toBe(true);
    expect(roleHasPermission('manager', 'day_close:execute')).toBe(true);

    expect(roleHasPermission('cashier', 'auth:self')).toBe(true);
    expect(roleHasPermission('cashier', 'users:read')).toBe(false);
    expect(roleHasPermission('cashier', 'users:write')).toBe(false);
    expect(roleHasPermission('cashier', 'users:unlock')).toBe(false);
    expect(roleHasPermission('cashier', 'catalog:read')).toBe(true);
    expect(roleHasPermission('cashier', 'catalog:write')).toBe(false);
    expect(roleHasPermission('cashier', 'stock:read')).toBe(true);
    expect(roleHasPermission('cashier', 'stock:write')).toBe(false);
    expect(roleHasPermission('cashier', 'cart:write')).toBe(true);
    expect(roleHasPermission('cashier', 'promotions:read')).toBe(true);
    expect(roleHasPermission('cashier', 'promotions:write')).toBe(false);
    expect(roleHasPermission('cashier', 'discounts:config')).toBe(false);
    expect(roleHasPermission('cashier', 'sale:void')).toBe(false);
    expect(roleHasPermission('cashier', 'sale:return')).toBe(false);
    expect(roleHasPermission('cashier', 'reports:profit')).toBe(false);
    expect(roleHasPermission('cashier', 'customers:read')).toBe(true);
    expect(roleHasPermission('cashier', 'customers:write')).toBe(true);
    expect(roleHasPermission('cashier', 'debt:pay')).toBe(true);
    expect(roleHasPermission('cashier', 'debt:manage')).toBe(false);
    expect(roleHasPermission('cashier', 'suppliers:read')).toBe(false);
    expect(roleHasPermission('cashier', 'suppliers:write')).toBe(false);
    expect(roleHasPermission('cashier', 'receiving:read')).toBe(false);
    expect(roleHasPermission('cashier', 'receiving:write')).toBe(false);
    expect(roleHasPermission('cashier', 'supplier_debt:pay')).toBe(false);
    expect(roleHasPermission('cashier', 'supplier_debt:manage')).toBe(false);
    expect(roleHasPermission('cashier', 'shifts:read')).toBe(true);
    expect(roleHasPermission('cashier', 'shifts:open')).toBe(true);
    expect(roleHasPermission('cashier', 'shifts:close')).toBe(true);
    expect(roleHasPermission('cashier', 'shifts:reclose')).toBe(false);
    expect(roleHasPermission('cashier', 'shifts:cash_move')).toBe(false);
    expect(roleHasPermission('cashier', 'day_close:execute')).toBe(false);
  });

  it('validates 6-12 digit PINs and rejects trivial or leaking error messages', () => {
    expect(validatePinFormat('849201')).toBe('849201');
    expect(validatePinFormat('9048172635')).toBe('9048172635');
    expect(validatePinFormat('112233445566')).toBe('112233445566');

    const rejected = [
      '1234',
      '12345',
      '000000',
      '77777777',
      '123456',
      '654321',
      '1234567',
      '84920a',
      '1234567890123',
    ];
    for (const bad of rejected) {
      try {
        validatePinFormat(bad);
        expect.unreachable(`Expected PIN ${bad} to be rejected`);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe('INVALID_PIN');
        // Never leak the rejected PIN into error message
        expect((err as DomainError).message).not.toContain(bad);
      }
    }
  });

  it('normalizes usernames and validates full names safely', () => {
    expect(normalizeUsername('  Owner_Main ')).toBe('owner_main');
    expect(normalizeUsername('kassir.1')).toBe('kassir.1');
    expect(() => normalizeUsername('a')).toThrow(DomainError);
    expect(() => normalizeUsername('user name')).toThrow(DomainError);
    expect(() => normalizeUsername('-invalid')).toThrow(DomainError);

    expect(validateFullName('  Ali Valiyev  ')).toBe('Ali Valiyev');
    expect(() => validateFullName('   ')).toThrow(DomainError);
    expect(() => validateFullName('x'.repeat(121))).toThrow(DomainError);
  });

  it('computes progressive device backoff capped at 60s starting after 15th failure', () => {
    for (let i = 0; i < PIN_SECURITY_CONSTANTS.MAX_DEVICE_FAILED_ATTEMPTS_IN_WINDOW; i++) {
      expect(computeDeviceCooldownDelayMs(i)).toBe(0n);
    }
    expect(computeDeviceCooldownDelayMs(15)).toBe(2_000n);
    expect(computeDeviceCooldownDelayMs(16)).toBe(4_000n);
    expect(computeDeviceCooldownDelayMs(17)).toBe(8_000n);
    expect(computeDeviceCooldownDelayMs(18)).toBe(16_000n);
    expect(computeDeviceCooldownDelayMs(19)).toBe(32_000n);
    expect(computeDeviceCooldownDelayMs(20)).toBe(60_000n);
    expect(computeDeviceCooldownDelayMs(50)).toBe(60_000n);

    expect(computeRetryAfterSeconds(0n)).toBe(0n);
    expect(computeRetryAfterSeconds(1n)).toBe(1n);
    expect(computeRetryAfterSeconds(1_500n)).toBe(2n);
    expect(computeRetryAfterSeconds(60_000n)).toBe(60n);
  });
});
