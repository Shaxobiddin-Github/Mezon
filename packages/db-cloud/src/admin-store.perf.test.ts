import { unixMsFromBigInt } from '@mezon/domain';
import { DeterministicUuidV7Generator } from '@mezon/test-utils';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionAppRole } from '../ops/provision-app-role.mjs';
import { AdminReadStore } from './admin-store.js';
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

const SALES = 100_000;
const PRODUCTS = 50_000;
const MOVES = 500_000;

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

/** T2.7a A5: cabinet queries on a large organization (100k receipts, 50k products, 500k moves). */
describePg('@mezon/db-cloud - AdminReadStore at volume (A5)', () => {
  let container: StartedPostgreSqlContainer;
  let adminConn: ReturnType<typeof createCloudPgPool<typeof schema>>;
  let appConn: ReturnType<typeof createCloudPgPool<typeof schema>>;
  let store: AdminReadStore;

  const idGen = new DeterministicUuidV7Generator();
  const org = idGen.nextId();
  const storeId = idGen.nextId();
  const owner = idGen.nextId();
  const device = idGen.nextId();
  const baseMs = 1_731_772_800_000n; // 2024-11-16 16:00 UTC
  const hlc = '000173177280000:00001:018f23a0-1234-7123-8123-123456789abc';
  // Deterministic UUIDv7-shaped ids from a series number and a 4-hex table tag.
  const uid = (tag: string, col: string) =>
    `('01950000-${tag}-7000-8000-' || lpad(to_hex(${col}), 12, '0'))::uuid`;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    adminConn = createCloudPgPool({ connectionString: container.getConnectionUri(), schema });
    const pw = 'test-mezon-app-password-perf-1234';
    process.env.MEZON_APP_DB_PASSWORD = pw;
    await provisionAppRole({ pool: adminConn.pool });
    await migrateCloudDatabase(adminConn.db);
    const appUri = new URL(container.getConnectionUri());
    appUri.username = PG_APP_ROLE_NAME;
    appUri.password = pw;
    appConn = createCloudPgPool({ connectionString: appUri.toString(), schema });
    store = new AdminReadStore({ pool: appConn.pool });

    await new CloudTenantStore(adminConn.pool).createOrganizationWithStoreAndOwner({
      organizationId: org,
      storeId,
      ownerUserId: owner,
      loginIdentityId: idGen.nextId(),
      organizationName: 'Perf Org',
      storeName: 'Perf Store',
      storeCode: 'perf',
      ownerUsername: 'perf_owner',
      ownerLogin: 'perf@guzar.uz',
      passwordHash: 'hash',
      nowMs: unixMsFromBigInt(baseMs),
    });

    await withPgTenantContext(adminConn.pool, org, async (_tx, c) => {
      const p = [org, storeId, device, hlc, baseMs.toString(), owner];
      await c.query(
        `INSERT INTO users (id, organization_id, device_id, hlc, created_at_ms, updated_at_ms,
                            username, full_name, role, is_active)
         VALUES ($5, $1, $2, $3, $4, $4, 'perf_owner', 'Perf Owner', 'owner', true)`,
        [org, device, hlc, baseMs.toString(), owner],
      );
      // 100k sales over ~58 days, one line and one payment each.
      await c.query(
        `INSERT INTO sales (
           id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms,
           cashier_user_id, completed_by_user_id, receipt_no, receipt_code, client_request_id, request_hash,
           subtotal_gross, total_promo_discount, subtotal_after_promo,
           manual_discount_mode, manual_discount_value, order_discount_amount,
           total_final, total_net_ex_vat, total_vat, total_paid, debt_amount, change_amount)
         SELECT ${uid('0001', 'g')}, $1, $2, $3, $4, $5::bigint - g::bigint * 50000, $5::bigint - g::bigint * 50000,
                $6, $6, g, 'R-' || g, ${uid('0002', 'g')}, 'hash-' || g,
                1000000, 0, 1000000, 'none', 0, 0, 1000000, 892857, 107143, 1000000, 0, 0
           FROM generate_series(1, ${SALES}) g`,
        p,
      );
      await c.query(
        `INSERT INTO sale_lines (
           id, organization_id, store_id, device_id, hlc, created_at_ms,
           sale_id, sort_order, line_kind, item_name, unit, qty,
           unit_price_snapshot, gross_total, promo_discount, subtotal_after_promo,
           allocated_order_discount, final_total, vat_rate_bp_snapshot, net_ex_vat, vat_total, cost_value)
         SELECT ${uid('0003', 'g')}, $1, $2, $3, $4, $5::bigint - g::bigint * 50000,
                ${uid('0001', 'g')}, 1, 'quick_sale', 'Non', 'dona', 1000,
                1000000, 1000000, 0, 1000000, 0, 1000000, 1200, 892857, 107143, 600000
           FROM generate_series(1, ${SALES}) g`,
        p.slice(0, 5),
      );
      await c.query(
        `INSERT INTO payments (
           id, organization_id, store_id, device_id, hlc, created_at_ms,
           sale_id, method, amount, tendered_amount, change_amount)
         SELECT ${uid('0004', 'g')}, $1, $2, $3, $4, $5::bigint - g::bigint * 50000,
                ${uid('0001', 'g')}, CASE WHEN g % 2 = 0 THEN 'cash' ELSE 'card' END,
                1000000, CASE WHEN g % 2 = 0 THEN 1000000 ELSE NULL END, 0
           FROM generate_series(1, ${SALES}) g`,
        p.slice(0, 5),
      );
      // 50k products, half with a min-stock alert; 500k stock moves (10 per product).
      await c.query(
        `INSERT INTO products (
           id, organization_id, device_id, hlc, created_at_ms, updated_at_ms,
           name, name_search, unit, sale_price, min_stock)
         SELECT ${uid('0005', 'g')}, $1, $2, $3, $4::bigint - g, $4::bigint - g,
                'Mahsulot ' || g, 'mahsulot ' || g, 'dona', 500000,
                CASE WHEN g % 2 = 0 THEN 20000 ELSE NULL END
           FROM generate_series(1, ${PRODUCTS}) g`,
        [org, device, hlc, baseMs.toString()],
      );
      await c.query(
        `INSERT INTO stock_moves (
           id, organization_id, store_id, device_id, hlc, created_at_ms,
           product_id, qty_delta, cost_value_delta, reason, source_type, source_id, created_by_user_id)
         SELECT ${uid('0006', 'g')}, $1, $2, $3, $4, $5::bigint - g,
                ${uid('0005', `((g - 1) % ${PRODUCTS}) + 1`)}, 1000, 600000, 'purchase', 'stock_entry',
                ${uid('0007', 'g')}, $6
           FROM generate_series(1, ${MOVES}) g`,
        p,
      );
      await c.query('ANALYZE');
    });
  }, 600_000);

  afterAll(async () => {
    await appConn?.pool.end();
    await adminConn?.pool.end();
    await container?.stop();
  });

  it('receipts list: first page and a deep page stay under 200 ms on 100k receipts', async () => {
    await store.getReceiptsList(org, { limit: 50 }); // warm-up
    const first = await timed(() => store.getReceiptsList(org, { limit: 50 }));
    let cursor = first.value.nextCursor;
    for (let i = 0; i < 20 && cursor; i += 1) {
      cursor = (await store.getReceiptsList(org, { limit: 50, cursor })).nextCursor;
    }
    const deep = await timed(() => store.getReceiptsList(org, { limit: 50, cursor: cursor! }));
    console.log(
      `[A5] receipts first page ${first.ms.toFixed(1)} ms, page 22 ${deep.ms.toFixed(1)} ms`,
    );
    expect(first.value.items).toHaveLength(50);
    expect(first.ms).toBeLessThan(200);
    expect(deep.ms).toBeLessThan(200);
  });

  it('dashboard and a 31-day report read only their range', async () => {
    const nowMs = unixMsFromBigInt(baseMs);
    await store.getDashboard({ organizationId: org, nowMs, includeProfit: true });
    const dash = await timed(() =>
      store.getDashboard({ organizationId: org, nowMs, includeProfit: true }),
    );
    const report = await timed(() =>
      store.getDailySalesReport({
        organizationId: org,
        fromDate: '2024-10-17',
        toDate: '2024-11-16',
        includeCostAndProfit: true,
      }),
    );
    console.log(
      `[A5] dashboard ${dash.ms.toFixed(1)} ms (${dash.value.receiptsCount} receipts today), ` +
        `31-day report ${report.ms.toFixed(1)} ms (${report.value.totalSalesCount} receipts)`,
    );
    expect(dash.value.receiptsCount).toBeGreaterThan(0);
    expect(dash.ms).toBeLessThan(500);
    expect(report.ms).toBeLessThan(3000);
  });

  it('low stock on 50k products and 500k moves', async () => {
    await store.getLowStockItems(org, storeId);
    const low = await timed(() => store.getLowStockItems(org, storeId));
    const products = await timed(() => store.getProductsList(org, { limit: 50 }));
    console.log(
      `[A5] low-stock ${low.ms.toFixed(1)} ms (${low.value.length} items), ` +
        `products page ${products.ms.toFixed(1)} ms`,
    );
    expect(low.value.length).toBeGreaterThan(0);
    expect(products.ms).toBeLessThan(200);
  });
});
