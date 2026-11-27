import {
  CloudAuthStore,
  CloudTenantStore,
  PG_APP_ROLE_NAME,
  createCloudPgPool,
  migrateCloudDatabase,
  shouldRunPgTests,
  withPgTenantContext,
} from '@mezon/db-cloud';
import { type UnixMs, unixMsFromBigInt } from '@mezon/domain';
import { FakeTelegramClient } from '@mezon/drivers';
import { DeterministicUuidV7Generator } from '@mezon/test-utils';
import * as argon2 from '@node-rs/argon2';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionAppRole } from '../../../packages/db-cloud/ops/provision-app-role.mjs';
import { loadCloudConfig } from './config.js';
import { CloudJwtService } from './jwt.js';
import { buildCloudServer } from './server.js';

const describePg = shouldRunPgTests() ? describe : describe.skip;

const HOUR = 3_600_000n;
// 2024-11-18 is a Monday. Tashkent = UTC+5.
const MON_09_TASHKENT = 1_731_902_400_000n; // 2024-11-18 04:00 UTC
const at = (base: bigint, hours: number) => unixMsFromBigInt(base + BigInt(hours) * HOUR);

describePg('@mezon/cloud - T2.8 Telegram bot (link, consent, digest, reminders)', () => {
  let container: StartedPostgreSqlContainer;
  let adminConn: ReturnType<typeof createCloudPgPool>;
  let appConn: ReturnType<typeof createCloudPgPool>;
  let server: FastifyInstance;
  const tg = new FakeTelegramClient();
  let nowMs: UnixMs = unixMsFromBigInt(MON_09_TASHKENT);
  const clock = { nowMs: () => nowMs };

  const idGen = new DeterministicUuidV7Generator();
  const org = idGen.nextId();
  const store = idGen.nextId();
  const owner = idGen.nextId();
  const manager = idGen.nextId();
  const cashier = idGen.nextId();
  const device = idGen.nextId();
  const customer = idGen.nextId();
  const otherOrg = idGen.nextId();
  const otherStore = idGen.nextId();
  const otherOwner = idGen.nextId();
  const hlc = '000173177280000:00001:018f23a0-1234-7123-8123-123456789abc';
  const password = 'TelegramBot2026!';
  const SECRET = 'webhook-secret-0123456789-abcdefghijklmnop';
  const OWNER_CHAT = '1001';
  const CUSTOMER_CHAT = '2002';
  let updateId = 1;

  const login = async (l: string) => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      payload: { login: l, password },
    });
    return (JSON.parse(res.payload) as { accessToken: string }).accessToken;
  };
  const webhook = (body: object, secret: string | null = SECRET) =>
    server.inject({
      method: 'POST',
      url: '/api/v1/telegram/webhook',
      headers: secret ? { 'x-telegram-bot-api-secret-token': secret } : {},
      payload: { update_id: updateId++, ...body },
    });
  const text = (chatId: string, t: string, lang = 'uz') =>
    webhook({
      message: {
        chat: { id: Number(chatId), type: 'private' },
        from: { language_code: lang },
        text: t,
      },
    });
  const press = (chatId: string, data: string) =>
    webhook({
      callback_query: { id: `cb${updateId}`, data, message: { chat: { id: Number(chatId) } } },
    });
  const lastTo = (chatId: string) => tg.messagesTo(chatId).at(-1);
  const tick = () => server.telegramScheduler!.tick();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    adminConn = createCloudPgPool({ connectionString: container.getConnectionUri() });
    const appPw = 'test-telegram-app-password-123456';
    process.env.MEZON_APP_DB_PASSWORD = appPw;
    await provisionAppRole({ pool: adminConn.pool });
    await migrateCloudDatabase(adminConn.db);
    const appUri = new URL(container.getConnectionUri());
    appUri.username = PG_APP_ROLE_NAME;
    appUri.password = appPw;
    appConn = createCloudPgPool({ connectionString: appUri.toString() });

    const hash = await argon2.hash(password);
    const tenants = new CloudTenantStore(adminConn.pool);
    await tenants.createOrganizationWithStoreAndOwner({
      organizationId: org,
      storeId: store,
      ownerUserId: owner,
      loginIdentityId: idGen.nextId(),
      organizationName: 'Guzar Non',
      storeName: 'Markaz',
      storeCode: 'markaz',
      ownerUsername: 'tg_owner',
      ownerLogin: 'tg_owner@guzar.uz',
      passwordHash: hash,
      nowMs,
    });
    await tenants.createOrganizationWithStoreAndOwner({
      organizationId: otherOrg,
      storeId: otherStore,
      ownerUserId: otherOwner,
      loginIdentityId: idGen.nextId(),
      organizationName: 'Boshqa',
      storeName: 'B',
      storeCode: 'b',
      ownerUsername: 'tg_other',
      ownerLogin: 'tg_other@guzar.uz',
      passwordHash: hash,
      nowMs,
    });
    await withPgTenantContext(adminConn.pool, org, async (_tx, c) => {
      for (const [id, name, role] of [
        [manager, 'tg_manager', 'manager'],
        [cashier, 'tg_cashier', 'cashier'],
      ] as const) {
        await c.query(
          `INSERT INTO cloud_users (id, organization_id, username, role, status, failed_login_attempts, created_at_ms, updated_at_ms)
           VALUES ($1, $2, $3, $4, 'active', 0, $5, $5)`,
          [id, org, name, role, String(nowMs)],
        );
        await c.query(
          `INSERT INTO cloud_login_identities (id, login, org_id, user_id, password_hash, created_at_ms, updated_at_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [idGen.nextId(), `${name}@guzar.uz`, org, id, hash, String(nowMs)],
        );
      }
      await c.query(
        `INSERT INTO users (id, organization_id, device_id, hlc, created_at_ms, updated_at_ms, username, full_name, role, is_active)
         VALUES ($1, $2, $3, $4, $5, $5, 'tg_owner', 'Ega', 'owner', true)`,
        [owner, org, device, hlc, String(nowMs)],
      );
      await c.query(
        `INSERT INTO customers (id, organization_id, device_id, hlc, created_at_ms, updated_at_ms, full_name, name_search)
         VALUES ($1, $2, $3, $4, $5, $5, 'Aziz Karimov', 'aziz karimov')`,
        [customer, org, device, hlc, String(nowMs)],
      );
      // 50,000 so'm opening debt, due a week ago -> fully overdue.
      await c.query(
        `INSERT INTO customer_ledger (id, organization_id, store_id, device_id, hlc, created_at_ms,
           customer_id, entry_type, amount_delta, source_type, source_id, created_by_user_id, reason, due_at_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'opening_balance', 5000000, 'opening_balance', $7, $8,
                 'Boshlang''ich qarz', $9)`,
        [
          idGen.nextId(),
          org,
          store,
          device,
          hlc,
          String(BigInt(nowMs) - 30n * 24n * HOUR),
          customer,
          owner,
          String(BigInt(nowMs) - 7n * 24n * HOUR),
        ],
      );
      // One sale today (09:00 Tashkent): 20,000 so'm.
      const sale = idGen.nextId();
      await c.query(
        `INSERT INTO sales (id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms,
           cashier_user_id, completed_by_user_id, receipt_no, receipt_code, client_request_id, request_hash,
           subtotal_gross, total_promo_discount, subtotal_after_promo, manual_discount_mode,
           manual_discount_value, order_discount_amount, total_final, total_net_ex_vat, total_vat,
           total_paid, debt_amount, change_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $7, 1, 'R-1', $8, 'hash-1', 2000000, 0, 2000000,
                 'none', 0, 0, 2000000, 1785714, 214286, 2000000, 0, 0)`,
        [sale, org, store, device, hlc, String(nowMs), owner, idGen.nextId()],
      );
      await c.query(
        `INSERT INTO sale_lines (id, organization_id, store_id, device_id, hlc, created_at_ms, sale_id,
           sort_order, line_kind, item_name, unit, qty, unit_price_snapshot, gross_total, promo_discount,
           subtotal_after_promo, allocated_order_discount, final_total, vat_rate_bp_snapshot, net_ex_vat,
           vat_total, cost_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'quick_sale', 'Non', 'dona', 2000, 1000000, 2000000, 0,
                 2000000, 0, 2000000, 1200, 1785714, 214286, 1200000)`,
        [idGen.nextId(), org, store, device, hlc, String(nowMs), sale],
      );
    });

    server = await buildCloudServer({
      config: loadCloudConfig({
        NODE_ENV: 'test',
        PORT: '3000',
        HOST: '127.0.0.1',
        DATABASE_URL: appUri.toString(),
        JWT_SECRET: 'telegram-test-jwt-secret-at-least-32-chars',
        CORS_ORIGINS: 'http://localhost:5173',
        TELEGRAM_BOT_TOKEN: '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-ra',
        TELEGRAM_WEBHOOK_SECRET: SECRET,
        TELEGRAM_BOT_USERNAME: 'guzar_test_bot',
      }),
      conn: appConn,
      jwtService: new CloudJwtService('telegram-test-jwt-secret-at-least-32-chars'),
      authStore: new CloudAuthStore(appConn.pool),
      clock,
      telegramClient: tg,
    });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await appConn?.pool.end();
    await adminConn?.pool.end();
    await container?.stop();
  });

  it('webhook rejects a missing or wrong secret and ignores garbage', async () => {
    expect((await webhook({}, null)).statusCode).toBe(401);
    expect((await webhook({}, `${SECRET}x`)).statusCode).toBe(401);
    expect((await webhook({ nonsense: true })).statusCode).toBe(200);
    expect(tg.sent).toHaveLength(0);
  });

  it('a cashier cannot create a link; the owner gets a one-time t.me link', async () => {
    // Cashiers cannot log in to the cloud at all; a (forged-for-test) cashier token must still be
    // refused by the route itself (defence in depth).
    const cashierToken = await new CloudJwtService(
      'telegram-test-jwt-secret-at-least-32-chars',
    ).signAccessToken({ sub: cashier, org, role: 'cashier', name: 'tg_cashier' });
    const denied = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/telegram/link',
      headers: { authorization: `Bearer ${cashierToken}` },
    });
    expect(denied.statusCode).toBe(403);

    const token = await login('tg_owner@guzar.uz');
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/telegram/link',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload) as { code: string; url: string };
    expect(body.url).toBe(`https://t.me/guzar_test_bot?start=${body.code}`);
    expect(body.code.length).toBeLessThanOrEqual(64);

    await text(OWNER_CHAT, `/start ${body.code}`);
    expect(lastTo(OWNER_CHAT)?.text).toContain('Guzar Non');
    // Reusing the code fails.
    await text('9999', `/start ${body.code}`);
    expect(lastTo('9999')?.text).toContain('Havola eskirgan');

    const status = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/telegram/status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.parse(status.payload)).toMatchObject({ enabled: true, linked: true });
  });

  it('an expired code is refused', async () => {
    const token = await login('tg_manager@guzar.uz');
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/telegram/link',
      headers: { authorization: `Bearer ${token}` },
    });
    const { code } = JSON.parse(res.payload) as { code: string };
    const saved = nowMs;
    nowMs = unixMsFromBigInt(BigInt(nowMs) + 16n * 60_000n);
    await text('3003', `/start ${code}`);
    nowMs = saved;
    expect(lastTo('3003')?.text).toContain('Havola eskirgan');
  });

  it('digest: nothing before the digest hour, exactly one after it, with the right figures', async () => {
    nowMs = at(MON_09_TASHKENT, 11); // 20:00 Tashkent
    expect((await tick()).digestsSent).toBe(0);
    nowMs = at(MON_09_TASHKENT, 12); // 21:00 Tashkent
    const before = tg.messagesTo(OWNER_CHAT).length;
    expect((await tick()).digestsSent).toBe(1);
    expect((await tick()).digestsSent).toBe(0); // same day: at most once
    const digest = tg.messagesTo(OWNER_CHAT).slice(before);
    expect(digest).toHaveLength(1);
    expect(digest[0]?.text).toContain('Guzar Non — 2024-11-18');
    expect(digest[0]?.text).toContain("Sof savdo: 20 000 so'm");
    expect(digest[0]?.text).toContain('Cheklar: 1');
    // Profit uses the hub formula: net ex VAT - cost = 17,857.14 - 12,000.
    expect(digest[0]?.text).toContain("Yalpi foyda: 5 857.14 so'm");
  });

  it('customer: no reminder before consent, one per ISO week after it', async () => {
    const token = await login('tg_owner@guzar.uz');
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/customers/${customer}/telegram-link`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(201);
    const { code } = JSON.parse(res.payload) as { code: string };
    await text(CUSTOMER_CHAT, `/start ${code}`, 'ru');
    const ask = lastTo(CUSTOMER_CHAT);
    expect(ask?.text).toContain('Guzar Non');
    expect(ask?.buttons[0]).toHaveLength(2);

    nowMs = at(MON_09_TASHKENT, 2); // Monday 11:00
    expect((await tick()).remindersSent).toBe(0); // no consent yet

    // A different chat cannot answer for this customer.
    const yes = ask?.buttons[0]?.[0]?.data ?? '';
    await press('5555', yes); // an unknown chat
    await press(OWNER_CHAT, yes); // a chat bound in the SAME organization, but not this link's
    expect((await tick()).remindersSent).toBe(0);

    await press(CUSTOMER_CHAT, yes);
    expect(lastTo(CUSTOMER_CHAT)?.text).toContain('/stop');
    expect((await tick()).remindersSent).toBe(1);
    const reminder = lastTo(CUSTOMER_CHAT)?.text ?? '';
    expect(reminder).toContain('Aziz Karimov');
    expect(reminder).toContain('50 000 сум');
    expect(reminder).toContain('просрочено: 50 000 сум');

    nowMs = at(MON_09_TASHKENT, 2 + 24 * 3); // Thursday, same ISO week
    expect((await tick()).remindersSent).toBe(0);
    nowMs = at(MON_09_TASHKENT, 2 + 24 * 7); // next Monday 11:00
    expect((await tick()).remindersSent).toBe(1);
  });

  it('C24: a linked customer gets a menu: own debts, the shop, the language', async () => {
    // after "yes" the bot showed the persistent menu (Russian chat)
    const consent = tg.messagesTo(CUSTOMER_CHAT).find((m) => m.text.includes('/stop'));
    expect(consent?.menu.flat()).toEqual(['💳 Мои долги', '🛍 Магазин', '🌐 Язык']);

    await text(CUSTOMER_CHAT, '💳 Мои долги', 'ru');
    const card = lastTo(CUSTOMER_CHAT)?.text ?? '';
    expect(card).toContain('Guzar Non');
    expect(card).toContain('Aziz Karimov');
    expect(card).toContain('Ваш долг: 50 000 сум');
    expect(card).toContain('Просрочено: 50 000 сум');

    // no public shop configured: an honest "not yet" instead of a broken button
    await text(CUSTOMER_CHAT, '🛍 Магазин', 'ru');
    expect(lastTo(CUSTOMER_CHAT)?.text).toContain('онлайн-заказ ещё не включён');

    // language switch: the menu comes back in Uzbek and the next answer is Uzbek
    await text(CUSTOMER_CHAT, '🌐 Язык', 'ru');
    const choose = lastTo(CUSTOMER_CHAT);
    expect(choose?.buttons[0]?.map((b) => b.data)).toEqual(['l:uz-Latn', 'l:ru']);
    await press(CUSTOMER_CHAT, 'l:uz-Latn');
    expect(lastTo(CUSTOMER_CHAT)?.menu.flat()).toEqual(['💳 Qarzlarim', '🛍 Doʻkon', '🌐 Til']);
    await text(CUSTOMER_CHAT, '💳 Qarzlarim', 'ru');
    expect(lastTo(CUSTOMER_CHAT)?.text).toContain("Qarzingiz: 50 000 so'm");

    // a chat that is not linked learns how to link, and sees no one's data
    await text('7777', '💳 Qarzlarim', 'uz');
    expect(lastTo('7777')?.text).toContain('havola');
    // the staff chat of the same shop is not a customer: no customer data either
    await text(OWNER_CHAT, '💳 Qarzlarim', 'uz');
    expect(lastTo(OWNER_CHAT)?.text).not.toContain('Aziz Karimov');

    // back to Russian for the tests below
    await press(CUSTOMER_CHAT, 'l:ru');
  });

  it('the cabinet shows the same overdue amount (FIFO), not 0', async () => {
    const token = await login('tg_owner@guzar.uz');
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/customers',
      headers: { authorization: `Bearer ${token}` },
    });
    const items = (
      JSON.parse(res.payload) as { items: { id: string; overdueAmountTiyin: string }[] }
    ).items;
    expect(items.find((i) => i.id === customer)?.overdueAmountTiyin).toBe('5000000');
  });

  it('a blocked chat revokes its binding; /stop unbinds everything', async () => {
    nowMs = at(MON_09_TASHKENT, 12 + 24); // Tuesday 21:00
    tg.markChatUnavailable(OWNER_CHAT);
    const r = await tick();
    expect(r.digestsSent).toBe(0);
    expect(r.failures).toBe(1);
    nowMs = at(MON_09_TASHKENT, 12 + 48); // Wednesday 21:00: the revoked chat is not retried
    expect((await tick()).failures).toBe(0);

    await text(CUSTOMER_CHAT, '/stop');
    // C24: the bot answers in the chat's saved language (this customer linked in Russian)
    expect(lastTo(CUSTOMER_CHAT)?.text).toContain('Отключено');
    nowMs = at(MON_09_TASHKENT, 2 + 24 * 14);
    expect((await tick()).remindersSent).toBe(0);
  });

  it('another organization never receives this one’s data', async () => {
    const token = await login('tg_other@guzar.uz');
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/customers/${customer}/telegram-link`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ---- ishchi2 review C1, conditions S1–S5 (mutations C2, C4, C5, C7, C8 used to survive) ----

  const setUserField = async (userId: string, column: 'status' | 'role', value: string) => {
    await withPgTenantContext(adminConn.pool, org, async (_tx, c) => {
      await c.query(`UPDATE cloud_users SET ${column} = $1 WHERE id = $2`, [value, userId]);
    });
  };
  const addDebtor = async (name: string): Promise<string> => {
    const id = idGen.nextId();
    await withPgTenantContext(adminConn.pool, org, async (_tx, c) => {
      await c.query(
        `INSERT INTO customers (id, organization_id, device_id, hlc, created_at_ms, updated_at_ms, full_name, name_search)
         VALUES ($1, $2, $3, $4, $5, $5, $6, lower($6))`,
        [id, org, device, hlc, String(MON_09_TASHKENT), name],
      );
      await c.query(
        `INSERT INTO customer_ledger (id, organization_id, store_id, device_id, hlc, created_at_ms,
           customer_id, entry_type, amount_delta, source_type, source_id, created_by_user_id, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'opening_balance', 1000000, 'opening_balance', $7, $8, 'Qarz')`,
        [idGen.nextId(), org, store, device, hlc, String(MON_09_TASHKENT), id, owner],
      );
    });
    return id;
  };
  const staffCode = async (loginName: string) => {
    const token = await login(loginName);
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/telegram/link',
      headers: { authorization: `Bearer ${token}` },
    });
    return (JSON.parse(res.payload) as { code: string }).code;
  };
  const customerCode = async (customerId: string) => {
    const token = await login('tg_owner@guzar.uz');
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/customers/${customerId}/telegram-link`,
      headers: { authorization: `Bearer ${token}` },
    });
    return (JSON.parse(res.payload) as { code: string }).code;
  };
  const consentFrom = async (chat: string, code: string) => {
    await text(chat, `/start ${code}`);
    const yes = lastTo(chat)?.buttons[0]?.[0]?.data ?? '';
    await press(chat, yes);
  };
  const week = (n: number, hourOffset: number) => at(MON_09_TASHKENT, hourOffset + 24 * 7 * n);

  it('S1: a blocked or demoted manager stops receiving the digest; the owner still gets it', async () => {
    nowMs = week(5, 0);
    await text('4004', `/start ${await staffCode('tg_manager@guzar.uz')}`);
    await text('4005', `/start ${await staffCode('tg_owner@guzar.uz')}`);

    nowMs = week(5, 12); // Monday 21:00
    await tick();
    expect(tg.messagesTo('4004').at(-1)?.text).toContain('Sof savdo');
    const managerBefore = tg.messagesTo('4004').length;
    const ownerBefore = tg.messagesTo('4005').length;

    await setUserField(manager, 'status', 'blocked');
    nowMs = week(5, 12 + 24); // Tuesday 21:00
    await tick();
    expect(tg.messagesTo('4004')).toHaveLength(managerBefore);
    expect(tg.messagesTo('4005')).toHaveLength(ownerBefore + 1);

    await setUserField(manager, 'status', 'active');
    await setUserField(manager, 'role', 'cashier');
    nowMs = week(5, 12 + 48); // Wednesday 21:00
    await tick();
    expect(tg.messagesTo('4004')).toHaveLength(managerBefore);
    expect(tg.messagesTo('4005')).toHaveLength(ownerBefore + 2);
    await setUserField(manager, 'role', 'manager');
  });

  it('S2: a deleted customer gets no more reminders', async () => {
    const debtor = await addDebtor('Olim Usmonov');
    nowMs = week(6, 0);
    await consentFrom('5005', await customerCode(debtor));
    nowMs = week(6, 2);
    await tick();
    const before = tg.messagesTo('5005').length;
    expect(tg.messagesTo('5005').at(-1)?.text).toContain('Olim Usmonov');

    await withPgTenantContext(adminConn.pool, org, async (_tx, c) => {
      await c.query('UPDATE customers SET deleted_at_ms = $1 WHERE id = $2', [
        String(week(6, 3)),
        debtor,
      ]);
    });
    nowMs = week(7, 2);
    await tick();
    expect(tg.messagesTo('5005')).toHaveLength(before);
  });

  it('S3: a staff code of a user blocked after issuing is refused and binds nothing', async () => {
    nowMs = week(8, 0);
    const code = await staffCode('tg_manager@guzar.uz');
    await setUserField(manager, 'status', 'blocked');
    await text('6006', `/start ${code}`);
    expect(lastTo('6006')?.text).toContain('Havola eskirgan');
    await setUserField(manager, 'status', 'active');
    nowMs = week(8, 12);
    await tick();
    expect(tg.messagesTo('6006')).toHaveLength(1); // only the refusal
  });

  it('S4: /start in a group chat binds nothing and does not consume the code', async () => {
    nowMs = week(9, 0);
    const debtor = await addDebtor('Guruh Sinov');
    const code = await customerCode(debtor);
    await webhook({
      message: {
        chat: { id: -100777, type: 'group' },
        from: { language_code: 'uz' },
        text: `/start ${code}`,
      },
    });
    expect(tg.messagesTo('-100777')).toHaveLength(0);
    // The same code still works in a private chat.
    await text('7006', `/start ${code}`);
    expect(lastTo('7006')?.buttons[0]).toHaveLength(2);
  });

  it('S5: re-linking a customer to another chat moves reminders there, once', async () => {
    const debtor = await addDebtor('Ikki Chat');
    nowMs = week(10, 0);
    await consentFrom('7007', await customerCode(debtor));
    await consentFrom('7008', await customerCode(debtor));
    nowMs = week(10, 2);
    await tick();
    expect(tg.messagesTo('7008').filter((m) => m.text.includes('Ikki Chat'))).toHaveLength(1);
    expect(tg.messagesTo('7007').filter((m) => m.text.includes('Ikki Chat'))).toHaveLength(0);
    await tick();
    expect(tg.messagesTo('7008').filter((m) => m.text.includes('Ikki Chat'))).toHaveLength(1);
  });

  it('owner 11-20: a transient failure is retried once after 15 minutes, never a third time', async () => {
    const MIN = 60_000n;
    nowMs = week(11, 12); // Monday 21:00
    tg.failNext(1);
    const first = await tick();
    expect(first.failures).toBe(1);
    const sentFirst = first.digestsSent;
    expect(sentFirst).toBeGreaterThan(0);
    // Too early: the failed one waits; nothing is sent twice.
    nowMs = unixMsFromBigInt(week(11, 12) + 5n * MIN);
    expect(await tick()).toMatchObject({ digestsSent: 0, failures: 0 });
    nowMs = unixMsFromBigInt(week(11, 12) + 20n * MIN);
    expect(await tick()).toMatchObject({ digestsSent: 1, failures: 0 });
    nowMs = unixMsFromBigInt(week(11, 12) + 60n * MIN);
    expect(await tick()).toMatchObject({ digestsSent: 0, failures: 0 });

    // Fails twice: the retry is the last attempt.
    nowMs = week(12, 12);
    tg.failNext(1);
    expect((await tick()).failures).toBe(1);
    nowMs = unixMsFromBigInt(week(12, 12) + 20n * MIN);
    tg.failNext(1);
    expect(await tick()).toMatchObject({ digestsSent: 0, failures: 1 });
    nowMs = unixMsFromBigInt(week(12, 12) + 40n * MIN);
    expect(await tick()).toMatchObject({ digestsSent: 0, failures: 0 });
  });
});
