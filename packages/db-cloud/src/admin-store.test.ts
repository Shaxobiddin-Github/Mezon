import {
  moneyFromTiyin,
  unixMsFromBigInt,
} from '@mezon/domain';
import { DeterministicUuidV7Generator } from '@mezon/test-utils';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionAppRole } from '../ops/provision-app-role.mjs';
import { AdminReadStore, maskPhoneNumber } from './admin-store.js';
import {
  PG_APP_ROLE_NAME,
  createCloudPgPool,
  migrateCloudDatabase,
  withPgTenantContext,
} from './index.js';
import { shouldRunPgTests } from './pg-test-helper.js';
import * as schema from './schema/index.js';
import { CloudTenantStore } from './tenant-store.js';

const describePg = shouldRunPgTests() ? describe : describe.skip;

describePg('@mezon/db-cloud - AdminReadStore queries and RLS isolation', () => {
  let container: StartedPostgreSqlContainer;
  let adminConn: ReturnType<typeof createCloudPgPool<typeof schema>>;
  let appConn: ReturnType<typeof createCloudPgPool<typeof schema>>;
  let tenantStore: CloudTenantStore;
  let adminStore: AdminReadStore;

  const idGen = new DeterministicUuidV7Generator();
  const orgA = idGen.nextId();
  const orgB = idGen.nextId();
  const storeA = idGen.nextId();
  const storeB = idGen.nextId();
  const ownerA = idGen.nextId();
  const ownerB = idGen.nextId();
  const deviceA = idGen.nextId();
  const nowMs = unixMsFromBigInt(1_731_772_800_000n); // 2026-11-16 16:00:00 UTC (21:00:00 Tashkent)
  const dummyHlc = '000173177280000:00001:018f23a0-1234-7123-8123-123456789abc';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    adminConn = createCloudPgPool({
      connectionString: container.getConnectionUri(),
      schema,
    });

    const testAppPassword = 'test-mezon-app-password-admin-1234';
    process.env.MEZON_APP_DB_PASSWORD = testAppPassword;
    await provisionAppRole({ pool: adminConn.pool });
    await migrateCloudDatabase(adminConn.db);

    const appUri = new URL(container.getConnectionUri());
    appUri.username = PG_APP_ROLE_NAME;
    appUri.password = testAppPassword;
    appConn = createCloudPgPool({
      connectionString: appUri.toString(),
      schema,
    });

    tenantStore = new CloudTenantStore(adminConn.pool);
    adminStore = new AdminReadStore({ pool: appConn.pool });

    // Seed Organization A
    await tenantStore.createOrganizationWithStoreAndOwner({
      organizationId: orgA,
      storeId: storeA,
      ownerUserId: ownerA,
      loginIdentityId: idGen.nextId(),
      organizationName: 'Tashkilot A',
      storeName: 'Do‘kon A',
      storeCode: 'store_a',
      ownerUsername: 'owner_a',
      ownerLogin: 'owner_a@guzar.uz',
      passwordHash: 'hash',
      nowMs,
    });

    // Seed Organization B
    await tenantStore.createOrganizationWithStoreAndOwner({
      organizationId: orgB,
      storeId: storeB,
      ownerUserId: ownerB,
      loginIdentityId: idGen.nextId(),
      organizationName: 'Tashkilot B',
      storeName: 'Do‘kon B',
      storeCode: 'store_b',
      ownerUsername: 'owner_b',
      ownerLogin: 'owner_b@guzar.uz',
      passwordHash: 'hash',
      nowMs,
    });
  }, 90000);

  afterAll(async () => {
    await appConn?.pool.end();
    await adminConn?.pool.end();
    await container?.stop();
  });

  it('masks phone numbers according to privacy rules', () => {
    expect(maskPhoneNumber('+998901234567')).toBe('+998 90 *** ** 67');
    expect(maskPhoneNumber(null)).toBeNull();
  });

  it('enforces store freshness staleness check (>10m)', async () => {
    const freshness = await adminStore.getStoreFreshness(orgA, nowMs);
    expect(freshness.length).toBe(1);
    expect(freshness[0]?.storeName).toBe('Do‘kon A');
    expect(freshness[0]?.isStale).toBe(true); // No events pushed yet -> isStale is true
  });

  it('calculates dashboard metrics excluding voided sales and isolates by tenant', async () => {
    const sale1Id = idGen.nextId();
    const sale2VoidedId = idGen.nextId();
    const ret1Id = idGen.nextId();

    // Insert user into domain users table for Org A
    await withPgTenantContext(appConn.pool, orgA, async (_tx, client) => {
      await client.query(
        `INSERT INTO users (
          id, organization_id, device_id, hlc, created_at_ms, updated_at_ms,
          username, full_name, role, is_active
        ) VALUES (
          $1, $2, $3, $4, $5, $5,
          'owner_a', 'Admin A', 'owner', true
        )`,
        [ownerA, orgA, deviceA, dummyHlc, nowMs.toString()],
      );

      // Insert completed sale and voided sale for Org A
      await client.query(
        `INSERT INTO sales (
          id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms,
          cashier_user_id, completed_by_user_id,
          receipt_no, receipt_code, client_request_id, request_hash,
          subtotal_gross, total_promo_discount, subtotal_after_promo,
          manual_discount_mode, manual_discount_value, order_discount_amount,
          total_final, total_net_ex_vat, total_vat, total_paid, debt_amount, change_amount
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $6,
          $7, $7,
          101, 'REC-101', $8, 'hash1123',
          1000000, 0, 1000000,
          'none', 0, 0,
          1000000, 892857, 107143, 1000000, 0, 0
        )`,
        [sale1Id, orgA, storeA, deviceA, dummyHlc, nowMs.toString(), ownerA, idGen.nextId()],
      );

      // Voided sale
      await client.query(
        `INSERT INTO sales (
          id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms,
          cashier_user_id, completed_by_user_id,
          receipt_no, receipt_code, client_request_id, request_hash,
          subtotal_gross, total_promo_discount, subtotal_after_promo,
          manual_discount_mode, manual_discount_value, order_discount_amount,
          total_final, total_net_ex_vat, total_vat, total_paid, debt_amount, change_amount,
          voided_at_ms, voided_by_user_id, void_reason, void_client_request_id, void_request_hash
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $6,
          $7, $7,
          102, 'REC-102', $8, 'hash2123',
          500000, 0, 500000,
          'none', 0, 0,
          500000, 446429, 53571, 500000, 0, 0,
          $6, $7, 'Kassir xatosi', $9, 'hash-void-sale-102'
        )`,
        [
          sale2VoidedId,
          orgA,
          storeA,
          deviceA,
          dummyHlc,
          nowMs.toString(),
          ownerA,
          idGen.nextId(),
          idGen.nextId(),
        ],
      );

      // Return
      await client.query(
        `INSERT INTO returns (
          id, organization_id, store_id, device_id, hlc, created_at_ms,
          sale_id, processed_by_user_id,
          return_no, return_code, client_request_id, request_hash, reason,
          total_refund, total_net_ex_vat, total_vat, cash_refund_amount, non_cash_refund_amount, debt_offset_amount
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8,
          1, 'RET-1', $9, 'hash3123', 'Mijoz qaytardi',
          100000, 89286, 10714, 100000, 0, 0
        )`,
        [
          ret1Id,
          orgA,
          storeA,
          deviceA,
          dummyHlc,
          nowMs.toString(),
          sale1Id,
          ownerA,
          idGen.nextId(),
        ],
      );
    });

    // Query dashboard for Org A
    const dashA = await adminStore.getDashboard({
      organizationId: orgA,
      storeId: storeA,
      nowMs,
      includeProfit: true,
    });

    // Gross sales should only include non-voided sale (1,000,000 tiyin)
    expect(dashA.grossSales).toEqual(moneyFromTiyin(1000000n));
    // Returns total should be 100,000 tiyin
    expect(dashA.returnsTotal).toEqual(moneyFromTiyin(100000n));
    // Net sales = 900,000 tiyin
    expect(dashA.netSales).toEqual(moneyFromTiyin(900000n));
    expect(dashA.receiptsCount).toBe(1);

    // Query dashboard for Org B (should be completely 0 due to RLS tenant isolation)
    const dashB = await adminStore.getDashboard({
      organizationId: orgB,
      storeId: storeB,
      nowMs,
      includeProfit: true,
    });
    expect(dashB.grossSales).toEqual(moneyFromTiyin(0n));
    expect(dashB.returnsTotal).toEqual(moneyFromTiyin(0n));
    expect(dashB.netSales).toEqual(moneyFromTiyin(0n));
    expect(dashB.receiptsCount).toBe(0);
  });

  it('retrieves paginated receipts list using keyset cursor and filters', async () => {
    const list = await adminStore.getReceiptsList(orgA, {
      storeId: storeA,
      limit: 10,
    });

    expect(list.items.length).toBe(2); // 1 completed, 1 voided
    expect(list.items[0]?.receiptNumber).toBe('REC-102');
    expect(list.items[0]?.status).toBe('voided');
    expect(list.items[1]?.receiptNumber).toBe('REC-101');
    expect(list.items[1]?.status).toBe('completed');
  });

  it('retrieves customers list with masked phone numbers and detail with unmasked phone for manager', async () => {
    const custId = idGen.nextId();
    await withPgTenantContext(appConn.pool, orgA, async (_tx, client) => {
      await client.query(
        `INSERT INTO customers (
          id, organization_id, device_id, hlc, created_at_ms, updated_at_ms,
          full_name, name_search, phone_normalized, phone_digits
        ) VALUES (
          $1, $2, $3, $4, $5, $5,
          'Alisher Navoiy', 'alisher navoiy', '+998901234567', '998901234567'
        )`,
        [custId, orgA, deviceA, dummyHlc, nowMs.toString()],
      );
    });

    // List view has masked phone
    const list = await adminStore.getCustomersList(orgA, { limit: 10 });
    expect(list.items.length).toBe(1);
    expect(list.items[0]?.fullName).toBe('Alisher Navoiy');
    expect(list.items[0]?.maskedPhone).toBe('+998 90 *** ** 67');

    // Detail view: privileged (manager/owner) gets full phone
    const privilegedDetail = await adminStore.getCustomerDetail({
      organizationId: orgA,
      customerId: custId,
      isPrivilegedRole: true,
    });
    expect(privilegedDetail?.phone).toBe('+998901234567');

    // Detail view: unprivileged gets masked phone
    const unprivilegedDetail = await adminStore.getCustomerDetail({
      organizationId: orgA,
      customerId: custId,
      isPrivilegedRole: false,
    });
    expect(unprivilegedDetail?.phone).toBe('+998 90 *** ** 67');
  });
});
