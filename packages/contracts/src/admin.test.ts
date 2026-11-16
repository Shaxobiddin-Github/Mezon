import { describe, expect, it } from 'vitest';
import {
  AdminDashboardResponseSchema,
  AdminReceiptsQuerySchema,
  maskPhoneNumber,
} from './admin.js';

describe('Admin contracts & helpers', () => {
  it('masks phone numbers properly for list views', () => {
    expect(maskPhoneNumber(null)).toBeNull();
    expect(maskPhoneNumber(undefined)).toBeNull();
    expect(maskPhoneNumber('+998901234567')).toBe('+998 90 *** ** 67');
    expect(maskPhoneNumber('901234567')).toBe('+998 90 *** ** 67');
    expect(maskPhoneNumber('+1234567890')).toBe('+1234 *** 90');
    expect(maskPhoneNumber('123')).toBe('***');
  });

  it('validates AdminDashboardResponseSchema', () => {
    const valid = {
      todayDate: '2026-11-16',
      grossSales: '15000000',
      returnsTotal: '200000',
      netSales: '14800000',
      receiptsCount: 42,
      avgReceipt: '352380',
      grossProfit: '5000000',
      marginBp: 3378,
      stores: [
        {
          storeId: '018f23a0-1234-7123-8123-123456789abc',
          storeName: 'Markaziy Filial',
          lastEventAtMs: '1731772800000',
          isStale: false,
        },
      ],
    };
    const parsed = AdminDashboardResponseSchema.parse(valid);
    expect(parsed.receiptsCount).toBe(42);
    expect(parsed.stores[0]?.isStale).toBe(false);
  });

  it('validates AdminReceiptsQuerySchema with keyset cursor and limits', () => {
    const parsed = AdminReceiptsQuerySchema.parse({
      cursor: '1731772800000:018f23a0-1234-7123-8123-123456789abc',
      limit: '100',
      status: 'completed',
    });
    expect(parsed.limit).toBe(100);
    expect(parsed.status).toBe('completed');
  });
});
