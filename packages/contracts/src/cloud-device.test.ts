import { describe, expect, it } from 'vitest';
import {
  CloudCreatePairingCodeRequestSchema,
  CloudPairDeviceRequestSchema,
  CloudRotateDeviceTokenRequestSchema,
  HubPairCloudRequestSchema,
} from './cloud-device.js';

describe('@mezon/contracts - Cloud Device & Pairing (T2.2)', () => {
  it('validates pairing code creation request', () => {
    const valid = CloudCreatePairingCodeRequestSchema.safeParse({
      storeId: '01950000-0000-7000-8000-000000000001',
      name: 'Kassa 1 (Monoblok)',
    });
    expect(valid.success).toBe(true);

    const invalid = CloudCreatePairingCodeRequestSchema.safeParse({
      storeId: 'bad-uuid',
      name: '',
    });
    expect(invalid.success).toBe(false);
  });

  it('validates device pairing request and enforces 8-character uppercase format', () => {
    const valid = CloudPairDeviceRequestSchema.safeParse({
      code: 'k7m9p2x4',
      deviceId: '01950000-0000-7000-8000-000000000002',
      platform: 'windows',
      appVersion: '1.0.0',
    });
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.code).toBe('K7M9P2X4');
    }

    const invalidCode = CloudPairDeviceRequestSchema.safeParse({
      code: 'TOO_LONG_123',
      deviceId: '01950000-0000-7000-8000-000000000002',
      platform: 'windows',
      appVersion: '1.0.0',
    });
    expect(invalidCode.success).toBe(false);
  });

  it('validates token rotation request with clientRequestId (D2 idempotency)', () => {
    const valid = CloudRotateDeviceTokenRequestSchema.safeParse({
      clientRequestId: '01950000-0000-7000-8000-000000000003',
    });
    expect(valid.success).toBe(true);

    const invalid = CloudRotateDeviceTokenRequestSchema.safeParse({
      clientRequestId: 'not-a-uuid',
    });
    expect(invalid.success).toBe(false);
  });

  it('validates hub pair request with cloud URL and code', () => {
    const valid = HubPairCloudRequestSchema.safeParse({
      cloudUrl: 'https://api.guzar.uz',
      code: 'ab23cd45',
    });
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.code).toBe('AB23CD45');
    }
  });
});
