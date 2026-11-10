import { encodeUuidV7, unixMsFromBigInt } from '@mezon/domain';
import { describe, expect, it } from 'vitest';
import {
  CreateUserRequestSchema,
  LoginRequestSchema,
  SetupRequestSchema,
  UpdateUserRequestSchema,
} from './index.js';

const SAMPLE_UUID = encodeUuidV7(
  unixMsFromBigInt(1_700_000_000_000n),
  new Uint8Array(10).fill(0x2a),
);

describe('@mezon/contracts - Zod schemas for Hub auth', () => {
  it('validates and normalizes SetupRequestSchema while rejecting weak PINs and unknown fields', () => {
    const ok = SetupRequestSchema.parse({
      owner: {
        fullName: '  Dilshod Karimov ',
        username: '  Owner_One ',
        pin: '839204',
      },
    });
    expect(ok).toEqual({
      owner: {
        fullName: 'Dilshod Karimov',
        username: 'owner_one',
        pin: '839204',
      },
    });

    expect(() =>
      SetupRequestSchema.parse({
        owner: { fullName: 'Owner', username: 'owner', pin: '123456' },
      }),
    ).toThrow();

    expect(() =>
      SetupRequestSchema.parse({
        owner: { fullName: 'Owner', username: 'owner', pin: '839204' },
        extraField: 'unexpected',
      }),
    ).toThrow();
  });

  it('supports login by username OR userId cleanly and rejects both/neither', () => {
    const byUser = LoginRequestSchema.parse({ username: 'Cashier_1', pin: '000000' });
    expect(byUser).toEqual({ username: 'cashier_1', pin: '000000' });

    const byId = LoginRequestSchema.parse({ userId: SAMPLE_UUID, pin: '839204' });
    expect(byId).toEqual({ userId: SAMPLE_UUID, pin: '839204' });

    expect(() =>
      LoginRequestSchema.parse({ username: 'cashier_1', userId: SAMPLE_UUID, pin: '839204' }),
    ).toThrow();
    expect(() => LoginRequestSchema.parse({ pin: '839204' })).toThrow();
  });

  it('rejects empty UpdateUserRequestSchema and unknown role values', () => {
    expect(() => UpdateUserRequestSchema.parse({})).toThrow();
    expect(() =>
      CreateUserRequestSchema.parse({
        fullName: 'Test',
        username: 'tester',
        role: 'superadmin',
        pin: '839204',
      }),
    ).toThrow();
  });
});
