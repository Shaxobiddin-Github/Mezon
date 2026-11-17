import { describe, expect, it } from 'vitest';
import {
  MONOTONE_TRANSITION_RULES,
  MIN_CLIENT_VERSION,
  CURRENT_SCHEMA_VERSION,
  SyncPushRequestSchema,
  SyncPullQuerySchema,
  parseAndValidateSyncCursors,
  validateSyncEntityPayload,
} from './sync.js';

describe('Contracts: Sync Module', () => {
  const dummyUuid1 = '01880000-0000-7000-8000-000000000001';
  const dummyUuid2 = '01880000-0000-7000-8000-000000000002';
  const dummyHlc = '0000000000000000000000000000000000000000000000000000000001';

  it('exposes protocol version constants', () => {
    expect(MIN_CLIENT_VERSION).toBe('1.0.0');
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });

  describe('P4: Strict Payload Validation', () => {
    it('validates correct users payload', () => {
      const validUser = {
        id: dummyUuid1,
        organizationId: dummyUuid2,
        username: 'alice',
        fullName: 'Alice Smith',
        role: 'cashier',
        isActive: true,
        deviceId: dummyUuid1,
        hlc: dummyHlc,
        createdAtMs: '1700000000000',
        updatedAtMs: '1700000000000',
      };
      const result = validateSyncEntityPayload('users', validUser);
      expect(result.success).toBe(true);
    });

    it('validates correct organization_tax_profiles payload and rejects invalid TIN or extra fields', () => {
      const validProfile = {
        id: dummyUuid1,
        organizationId: dummyUuid1,
        deviceId: dummyUuid2,
        hlc: dummyHlc,
        createdAtMs: '1700000000000',
        updatedAtMs: '1700000000000',
        deletedAtMs: null,
        tin: '123456789',
        legalName: 'Test MCHJ',
        legalAddress: 'Navoiy 1',
        isVatPayer: true,
        defaultVatRateBp: 1200,
        updatedByUserId: dummyUuid2,
      };
      const validRes = validateSyncEntityPayload('organization_tax_profiles', validProfile);
      expect(validRes.success).toBe(true);

      const invalidTin = { ...validProfile, tin: '1234' };
      const invalidRes = validateSyncEntityPayload('organization_tax_profiles', invalidTin);
      expect(invalidRes.success).toBe(false);

      const extraField = { ...validProfile, evilProp: true };
      const extraRes = validateSyncEntityPayload('organization_tax_profiles', extraField);
      expect(extraRes.success).toBe(false);
    });

    it('P4: rejects users payload containing forbidden extra fields like pin_hash or pin', () => {
      const evilUser = {
        id: dummyUuid1,
        organizationId: dummyUuid2,
        username: 'alice',
        fullName: 'Alice Smith',
        role: 'cashier',
        isActive: true,
        pin_hash: 'argon2id$evil$hash', // Extra field!
        deviceId: dummyUuid1,
        hlc: dummyHlc,
        createdAtMs: '1700000000000',
        updatedAtMs: '1700000000000',
      };
      const result = validateSyncEntityPayload('users', evilUser);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('pin_hash');
      }
    });

    it('rejects unknown entity name', () => {
      const result = validateSyncEntityPayload('non_existent_table', { foo: 'bar' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Unknown or non-synced entity');
      }
    });
  });

  describe('P3: Shared MONOTONE Transition Rules', () => {
    describe('sales', () => {
      const rule = MONOTONE_TRANSITION_RULES.sales;

      it('allows transition from null voided_at_ms to timestamp', () => {
        const existing = { voided_at_ms: null };
        const incoming = { voided_at_ms: '1700000000000', void_reason: 'Mistake' };
        expect(rule.checkTransition(existing, incoming)).toBe('accepted');
      });

      it('returns duplicate when same voided_at_ms is re-applied', () => {
        const existing = { voided_at_ms: '1700000000000' };
        const incoming = { voided_at_ms: '1700000000000' };
        expect(rule.checkTransition(existing, incoming)).toBe('duplicate');
      });

      it('rejects modifying already-voided sale with different voided_at_ms', () => {
        const existing = { voided_at_ms: '1700000000000' };
        const incoming = { voided_at_ms: '1700000005000' };
        expect(rule.checkTransition(existing, incoming)).toBe('rejected');
      });

      it('rejects un-voiding an already voided sale', () => {
        const existing = { voided_at_ms: '1700000000000' };
        const incoming = { voided_at_ms: null };
        expect(rule.checkTransition(existing, incoming)).toBe('rejected');
      });
    });

    describe('orders', () => {
      const rule = MONOTONE_TRANSITION_RULES.orders;

      it('allows valid state progression draft -> confirmed -> ready -> delivered', () => {
        expect(rule.checkTransition({ status: 'draft' }, { status: 'confirmed' })).toBe('accepted');
        expect(rule.checkTransition({ status: 'confirmed' }, { status: 'ready' })).toBe('accepted');
        expect(rule.checkTransition({ status: 'ready' }, { status: 'delivered' })).toBe('accepted');
      });

      it('returns duplicate on idempotent re-application of same status', () => {
        expect(rule.checkTransition({ status: 'confirmed' }, { status: 'confirmed' })).toBe(
          'duplicate',
        );
        expect(rule.checkTransition({ status: 'delivered' }, { status: 'delivered' })).toBe(
          'duplicate',
        );
      });

      it('rejects backward or illegal state transitions', () => {
        expect(rule.checkTransition({ status: 'delivered' }, { status: 'draft' })).toBe('rejected');
        expect(rule.checkTransition({ status: 'cancelled' }, { status: 'confirmed' })).toBe(
          'rejected',
        );
        expect(rule.checkTransition({ status: 'draft' }, { status: 'ready' })).toBe('rejected');
      });
    });

    describe('shifts', () => {
      const rule = MONOTONE_TRANSITION_RULES.shifts;

      it('allows open -> closed transition', () => {
        expect(rule.checkTransition({ status: 'open' }, { status: 'closed' })).toBe('accepted');
      });

      it('returns duplicate on closed -> closed', () => {
        expect(rule.checkTransition({ status: 'closed' }, { status: 'closed' })).toBe('duplicate');
      });

      it('rejects closed -> open transition', () => {
        expect(rule.checkTransition({ status: 'closed' }, { status: 'open' })).toBe('rejected');
      });
    });

    describe('inventory_counts', () => {
      const rule = MONOTONE_TRANSITION_RULES.inventory_counts;

      it('allows open -> finalized transition', () => {
        expect(rule.checkTransition({ status: 'open' }, { status: 'finalized' })).toBe('accepted');
      });

      it('returns duplicate on finalized -> finalized', () => {
        expect(rule.checkTransition({ status: 'finalized' }, { status: 'finalized' })).toBe(
          'duplicate',
        );
      });

      it('rejects finalized -> open transition', () => {
        expect(rule.checkTransition({ status: 'finalized' }, { status: 'open' })).toBe('rejected');
      });
    });
  });

  describe('SyncPushRequestSchema', () => {
    it('validates a valid push request envelope', () => {
      const req = {
        clientVersion: '1.0.0',
        storeId: dummyUuid1,
        deviceId: dummyUuid2,
        events: [
          {
            eventId: dummyUuid1,
            organizationId: dummyUuid2,
            storeId: dummyUuid1,
            deviceId: dummyUuid2,
            deviceSeq: '42',
            hlc: dummyHlc,
            type: 'CATALOG_PRODUCT_CREATED',
            entity: 'products',
            entityId: dummyUuid1,
            entityClass: 'ATTR',
            schemaVersion: 1,
            payload: { name: 'Test' },
          },
        ],
      };
      const result = SyncPushRequestSchema.safeParse(req);
      expect(result.success).toBe(true);
    });

    it('rejects batch exceeding 100 events', () => {
      const events = Array.from({ length: 101 }, (_, i) => ({
        eventId: dummyUuid1,
        organizationId: dummyUuid2,
        storeId: dummyUuid1,
        deviceId: dummyUuid2,
        deviceSeq: String(i + 1),
        hlc: dummyHlc,
        type: 'TEST',
        entity: 'products',
        entityId: dummyUuid1,
        entityClass: 'ATTR' as const,
        schemaVersion: 1,
        payload: {},
      }));

      const result = SyncPushRequestSchema.safeParse({
        clientVersion: '1.0.0',
        storeId: dummyUuid1,
        deviceId: dummyUuid2,
        events,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('T2.4: Sync Pull Cursors & Query Validation', () => {
    it('parses empty or undefined cursors string to empty map', () => {
      expect(parseAndValidateSyncCursors(undefined)).toEqual({ success: true, cursors: {} });
      expect(parseAndValidateSyncCursors('')).toEqual({ success: true, cursors: {} });
      expect(parseAndValidateSyncCursors('   ')).toEqual({ success: true, cursors: {} });
    });

    it('parses valid multiple store cursors string', () => {
      const input = `${dummyUuid1}:105,${dummyUuid2}:42`;
      const res = parseAndValidateSyncCursors(input);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.cursors).toEqual({
          [dummyUuid1]: 105n,
          [dummyUuid2]: 42n,
        });
      }
    });

    it('rejects invalid cursor format, invalid UUID, or non-numeric position', () => {
      expect(parseAndValidateSyncCursors('invalid_format').success).toBe(false);
      expect(parseAndValidateSyncCursors('not-a-uuid:10').success).toBe(false);
      expect(parseAndValidateSyncCursors(`${dummyUuid1}:abc`).success).toBe(false);
      expect(parseAndValidateSyncCursors(`${dummyUuid1}:-5`).success).toBe(false);
    });

    it('validates SyncPullQuerySchema default limit and boundary', () => {
      const parsedDefault = SyncPullQuerySchema.parse({});
      expect(parsedDefault.limit).toBe(100);

      const parsedCustom = SyncPullQuerySchema.parse({ limit: '250', cursors: `${dummyUuid1}:10` });
      expect(parsedCustom.limit).toBe(250);
      expect(parsedCustom.cursors).toBe(`${dummyUuid1}:10`);

      expect(SyncPullQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
      expect(SyncPullQuerySchema.safeParse({ limit: 501 }).success).toBe(false);
    });
  });
});
