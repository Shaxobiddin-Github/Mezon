import { describe, expect, it } from 'vitest';
import {
  CloudCreateStoreRequestSchema,
  CloudLoginRequestSchema,
  CloudRefreshRequestSchema,
  CloudUserRoleSchema,
  normalizeCloudLogin,
} from './cloud-auth.js';

describe('@mezon/contracts - Cloud Auth & Stores', () => {
  it('normalizes logins properly across emails, phones and usernames (S3)', () => {
    // Email normalization: trim and lowercase
    expect(normalizeCloudLogin('  Ali@X.UZ  ')).toBe('ali@x.uz');
    expect(normalizeCloudLogin('Owner.Main@Guzar.Uz')).toBe('owner.main@guzar.uz');

    // Phone normalization: 9 digits -> +998...
    expect(normalizeCloudLogin(' 90 123 45 67 ')).toBe('+998901234567');
    expect(normalizeCloudLogin('901234567')).toBe('+998901234567');

    // Phone normalization: 12 digits (with or without +) -> +998...
    expect(normalizeCloudLogin('998901234567')).toBe('+998901234567');
    expect(normalizeCloudLogin('+998 (90) 123-45-67')).toBe('+998901234567');

    // Non-phone logins containing letters are not mangled
    expect(normalizeCloudLogin('user998@x.uz')).toBe('user998@x.uz');
    expect(normalizeCloudLogin('  Admin_Guzar  ')).toBe('admin_guzar');
  });

  it('validates and normalizes cloud login input', () => {
    const valid = CloudLoginRequestSchema.safeParse({
      login: '  Owner@Guzar.UZ  ',
      password: 'password123',
    });
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.login).toBe('owner@guzar.uz');
    }

    const validPhone = CloudLoginRequestSchema.safeParse({
      login: ' 90 123-45-67 ',
      password: 'password123',
    });
    expect(validPhone.success).toBe(true);
    if (validPhone.success) {
      expect(validPhone.data.login).toBe('+998901234567');
    }

    const tooShort = CloudLoginRequestSchema.safeParse({
      login: 'ab',
      password: '123',
    });
    expect(tooShort.success).toBe(false);
  });

  it('restricts cloud user roles strictly to owner and manager (C3)', () => {
    expect(CloudUserRoleSchema.safeParse('owner').success).toBe(true);
    expect(CloudUserRoleSchema.safeParse('manager').success).toBe(true);
    expect(CloudUserRoleSchema.safeParse('platform_admin').success).toBe(false);
    expect(CloudUserRoleSchema.safeParse('cashier').success).toBe(false);
  });

  it('validates refresh request schema', () => {
    expect(CloudRefreshRequestSchema.safeParse({ refreshToken: 'short' }).success).toBe(false);
    expect(
      CloudRefreshRequestSchema.safeParse({
        refreshToken: '01950000-0000-7000-8000-000000000001.c29tZXJhbmRvbXRva2Vu',
      }).success,
    ).toBe(true);
  });

  it('validates store creation request', () => {
    const valid = CloudCreateStoreRequestSchema.safeParse({
      name: 'Guzar Kattaqorgon #1',
      code: 'guzar_kq_01',
    });
    expect(valid.success).toBe(true);

    const invalidCode = CloudCreateStoreRequestSchema.safeParse({
      name: 'Bad Store',
      code: 'invalid code with spaces!',
    });
    expect(invalidCode.success).toBe(false);
  });
});
