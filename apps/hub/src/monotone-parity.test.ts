import { MONOTONE_TRANSITION_RULES } from '@mezon/contracts';
import {
  FISCAL_DOC_STATUSES,
  type FiscalDocStatus,
  isFiscalDocTransitionAllowed,
} from '@mezon/domain';
import { migrateLocalDatabase, openLocalSqliteDatabase } from '@mezon/db-local';
import { describe, expect, it } from 'vitest';

describe('@mezon/hub - MONOTONE SQLite Triggers & Cloud Engine Parity (R2)', () => {
  it('enforces identical state transitions between SQLite triggers and MONOTONE_TRANSITION_RULES across all 6 MONOTONE tables', () => {
    const conn = openLocalSqliteDatabase(':memory:');
    migrateLocalDatabase(conn.db);
    const db = conn.sqlite;

    const orgId = '018bcfe5-6800-7000-8000-000000000001';
    const storeId = '018bcfe5-6800-7000-8000-000000000011';
    const deviceId = '018bcfe5-6800-7000-8000-000000000111';
    const userId = '018bcfe5-6800-7000-8000-000000000003';
    const hlc0 = '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111';
    const nowMs = 1700000000000n;

    // Seed required foreign keys
    db.prepare(
      `
      INSERT INTO users (id, organization_id, device_id, hlc, created_at_ms, updated_at_ms, username, full_name, role, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 'test_user', 'Test User', 'owner', 1)
    `,
    ).run(userId, orgId, deviceId, hlc0, nowMs, nowMs);

    // ========================================================================
    // 1. sales: voided_at_ms (active -> voided)
    // ========================================================================
    const saleId = '018bcfe5-6800-7000-8000-000000000021';
    const shiftId = '018bcfe5-6800-7000-8000-000000000022';

    // Seed shift for sale foreign key
    db.prepare(
      `
      INSERT INTO shifts (id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms, shift_no, shift_code, status, opened_by_user_id, opening_cash, opened_at_ms, open_client_request_id, open_request_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'SHF-001', 'open', ?, 0, ?, '018bcfe5-6800-7000-8000-000000000023', 'hash123456')
    `,
    ).run(shiftId, orgId, storeId, deviceId, hlc0, nowMs, nowMs, userId, nowMs);

    db.prepare(
      `
      INSERT INTO sales (
        id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms,
        shift_id, cashier_user_id, completed_by_user_id, client_request_id, request_hash,
        receipt_no, receipt_code, subtotal_gross, total_promo_discount, subtotal_after_promo,
        manual_discount_mode, manual_discount_value, order_discount_amount, total_final,
        total_net_ex_vat, total_vat, total_paid, debt_amount, change_amount
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, '018bcfe5-6800-7000-8000-000000000024', 'hash123456',
        1, 'REC-001', 10000, 0, 10000,
        'none', 0, 0, 10000,
        8929, 1071, 10000, 0, 0
      )
    `,
    ).run(saleId, orgId, storeId, deviceId, hlc0, nowMs, nowMs, shiftId, userId, userId);

    const initialSale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId) as Record<
      string,
      unknown
    >;
    expect(initialSale.voided_at_ms).toBeNull();

    // 1a. Allowed transition: active -> voided
    const voidClientReqId = '018bcfe5-6800-7000-8000-000000000025';
    const voidReqHash = 'hash654321';
    const voidedPayload = {
      ...initialSale,
      voided_at_ms: '1700000010000',
      voided_by_user_id: userId,
      void_reason: 'Mistake',
      void_client_request_id: voidClientReqId,
      void_request_hash: voidReqHash,
    };
    expect(MONOTONE_TRANSITION_RULES.sales.checkTransition(initialSale, voidedPayload)).toBe(
      'accepted',
    );
    expect(() => {
      db.prepare(
        `
        UPDATE sales
        SET voided_at_ms = ?, voided_by_user_id = ?, void_reason = ?, void_client_request_id = ?, void_request_hash = ?
        WHERE id = ?
      `,
      ).run(1700000010000n, userId, 'Mistake', voidClientReqId, voidReqHash, saleId);
    }).not.toThrow();

    // 1b. Duplicate transition: voided -> voided (same timestamp)
    const currentVoidedSale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId) as Record<
      string,
      unknown
    >;
    expect(MONOTONE_TRANSITION_RULES.sales.checkTransition(currentVoidedSale, voidedPayload)).toBe(
      'duplicate',
    );

    // 1c. Illegal transition: attempting to un-void
    const unvoidPayload = { ...currentVoidedSale, voided_at_ms: null };
    expect(MONOTONE_TRANSITION_RULES.sales.checkTransition(currentVoidedSale, unvoidPayload)).toBe(
      'rejected',
    );
    expect(() => {
      db.prepare('UPDATE sales SET voided_at_ms = NULL WHERE id = ?').run(saleId);
    }).toThrow();

    // Close shiftId so device can open next shift in section 3
    db.prepare(
      `
      UPDATE shifts
      SET status = 'closed', closed_at_ms = ?, closed_by_user_id = ?, close_client_request_id = '018bcfe5-6800-7000-8000-000000000026', close_request_hash = 'hash654321'
      WHERE id = ?
    `,
    ).run(nowMs + 1000n, userId, shiftId);

    // ========================================================================
    // 2. orders: status (draft -> confirmed -> ready -> delivered / cancelled)
    // ========================================================================
    const orderId = '018bcfe5-6800-7000-8000-000000000031';
    db.prepare(
      `
      INSERT INTO orders (id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms, origin_device_id, order_no, order_code, status, customer_name, subtotal_gross, total_promo_discount, subtotal_after_promo, manual_discount_mode, manual_discount_value, order_discount_amount, total_amount, total_net_ex_vat, total_vat, created_by_user_id, create_client_request_id, create_request_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 101, 'ORD-101', 'draft', 'Customer 1', 50000, 0, 50000, 'none', 0, 0, 50000, 44643, 5357, ?, '018bcfe5-6800-7000-8000-000000000032', 'hash123456')
    `,
    ).run(orderId, orgId, storeId, deviceId, hlc0, nowMs, nowMs, deviceId, userId);

    let currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<
      string,
      unknown
    >;

    // 2a. Allowed: draft -> confirmed
    const confirmedOrderPayload = { ...currentOrder, status: 'confirmed' };
    expect(
      MONOTONE_TRANSITION_RULES.orders.checkTransition(currentOrder, confirmedOrderPayload),
    ).toBe('accepted');
    expect(() => {
      db.prepare("UPDATE orders SET status = 'confirmed', confirmed_at_ms = ? WHERE id = ?").run(
        nowMs,
        orderId,
      );
    }).not.toThrow();

    currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<
      string,
      unknown
    >;

    // 2b. Duplicate: confirmed -> confirmed
    expect(
      MONOTONE_TRANSITION_RULES.orders.checkTransition(currentOrder, confirmedOrderPayload),
    ).toBe('duplicate');

    // 2c. Illegal reverse: confirmed -> draft
    const reverseDraftPayload = { ...currentOrder, status: 'draft' };
    expect(
      MONOTONE_TRANSITION_RULES.orders.checkTransition(currentOrder, reverseDraftPayload),
    ).toBe('rejected');
    expect(() => {
      db.prepare("UPDATE orders SET status = 'draft' WHERE id = ?").run(orderId);
    }).toThrow();

    // 2d. Allowed: confirmed -> ready
    const readyOrderPayload = { ...currentOrder, status: 'ready' };
    expect(MONOTONE_TRANSITION_RULES.orders.checkTransition(currentOrder, readyOrderPayload)).toBe(
      'accepted',
    );
    expect(() => {
      db.prepare("UPDATE orders SET status = 'ready', ready_at_ms = ? WHERE id = ?").run(
        nowMs,
        orderId,
      );
    }).not.toThrow();

    currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<
      string,
      unknown
    >;

    // 2e. Allowed: ready -> delivered (terminal)
    const deliveredOrderPayload = {
      ...currentOrder,
      status: 'delivered',
      delivered_at_ms: nowMs,
      delivered_sale_id: saleId,
    };
    expect(
      MONOTONE_TRANSITION_RULES.orders.checkTransition(currentOrder, deliveredOrderPayload),
    ).toBe('accepted');
    expect(() => {
      db.prepare(
        "UPDATE orders SET status = 'delivered', delivered_at_ms = ?, delivered_sale_id = ? WHERE id = ?",
      ).run(nowMs, saleId, orderId);
    }).not.toThrow();

    currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<
      string,
      unknown
    >;

    // 2f. Illegal: delivered -> cancelled
    const cancelledOrderPayload = { ...currentOrder, status: 'cancelled' };
    expect(
      MONOTONE_TRANSITION_RULES.orders.checkTransition(currentOrder, cancelledOrderPayload),
    ).toBe('rejected');
    expect(() => {
      db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
    }).toThrow();

    // ========================================================================
    // 3. shifts: status (open -> closed)
    // ========================================================================
    const shiftTestId = '018bcfe5-6800-7000-8000-000000000041';
    db.prepare(
      `
      INSERT INTO shifts (id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms, shift_no, shift_code, status, opened_by_user_id, opening_cash, opened_at_ms, open_client_request_id, open_request_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, 2, 'SHF-002', 'open', ?, 0, ?, '018bcfe5-6800-7000-8000-000000000042', 'hash123456')
    `,
    ).run(shiftTestId, orgId, storeId, deviceId, hlc0, nowMs, nowMs, userId, nowMs);

    let currentShift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftTestId) as Record<
      string,
      unknown
    >;

    // 3a. Allowed: open -> closed
    const closeClientReqId = '018bcfe5-6800-7000-8000-000000000043';
    const closeReqHash = 'hash654321';
    const closedShiftPayload = { ...currentShift, status: 'closed' };
    expect(MONOTONE_TRANSITION_RULES.shifts.checkTransition(currentShift, closedShiftPayload)).toBe(
      'accepted',
    );
    expect(() => {
      db.prepare(
        `
        UPDATE shifts
        SET status = 'closed', closed_at_ms = ?, closed_by_user_id = ?, close_client_request_id = ?, close_request_hash = ?
        WHERE id = ?
      `,
      ).run(nowMs + 1000n, userId, closeClientReqId, closeReqHash, shiftTestId);
    }).not.toThrow();

    currentShift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftTestId) as Record<
      string,
      unknown
    >;

    // 3b. Duplicate: closed -> closed
    expect(MONOTONE_TRANSITION_RULES.shifts.checkTransition(currentShift, closedShiftPayload)).toBe(
      'duplicate',
    );

    // 3c. Illegal: closed -> open
    const reopenShiftPayload = { ...currentShift, status: 'open' };
    expect(MONOTONE_TRANSITION_RULES.shifts.checkTransition(currentShift, reopenShiftPayload)).toBe(
      'rejected',
    );
    expect(() => {
      db.prepare("UPDATE shifts SET status = 'open' WHERE id = ?").run(shiftTestId);
    }).toThrow();

    // ========================================================================
    // 4. shift_cashier_sessions: status (active -> closed)
    // ========================================================================
    const sessionId = '018bcfe5-6800-7000-8000-000000000051';
    db.prepare(
      `
      INSERT INTO shift_cashier_sessions (id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms, shift_id, cashier_user_id, session_seq, started_at_ms, opening_float, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 'active')
    `,
    ).run(sessionId, orgId, storeId, deviceId, hlc0, nowMs, nowMs, shiftTestId, userId, nowMs);

    let currentSession = db
      .prepare('SELECT * FROM shift_cashier_sessions WHERE id = ?')
      .get(sessionId) as Record<string, unknown>;

    // 4a. Allowed: active -> closed
    const closedSessionPayload = { ...currentSession, status: 'closed' };
    expect(
      MONOTONE_TRANSITION_RULES.shift_cashier_sessions.checkTransition(
        currentSession,
        closedSessionPayload,
      ),
    ).toBe('accepted');
    expect(() => {
      db.prepare(
        `
        UPDATE shift_cashier_sessions
        SET status = 'closed', ended_at_ms = ?, expected_cash = 0, counted_cash = 0, discrepancy = 0
        WHERE id = ?
      `,
      ).run(nowMs + 1000n, sessionId);
    }).not.toThrow();

    currentSession = db
      .prepare('SELECT * FROM shift_cashier_sessions WHERE id = ?')
      .get(sessionId) as Record<string, unknown>;

    // 4b. Duplicate: closed -> closed
    expect(
      MONOTONE_TRANSITION_RULES.shift_cashier_sessions.checkTransition(
        currentSession,
        closedSessionPayload,
      ),
    ).toBe('duplicate');

    // 4c. Illegal: closed -> active
    const reactivateSessionPayload = { ...currentSession, status: 'active' };
    expect(
      MONOTONE_TRANSITION_RULES.shift_cashier_sessions.checkTransition(
        currentSession,
        reactivateSessionPayload,
      ),
    ).toBe('rejected');
    expect(() => {
      db.prepare("UPDATE shift_cashier_sessions SET status = 'active' WHERE id = ?").run(sessionId);
    }).toThrow();

    // ========================================================================
    // 5. inventory_counts: status (open -> finalized | cancelled)
    // ========================================================================
    const countId = '018bcfe5-6800-7000-8000-000000000061';
    db.prepare(
      `
      INSERT INTO inventory_counts (id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms, status, started_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
    `,
    ).run(countId, orgId, storeId, deviceId, hlc0, nowMs, nowMs, userId);

    let currentCount = db
      .prepare('SELECT * FROM inventory_counts WHERE id = ?')
      .get(countId) as Record<string, unknown>;

    // 5a. Allowed: open -> finalized
    const finalizedCountPayload = { ...currentCount, status: 'finalized' };
    expect(
      MONOTONE_TRANSITION_RULES.inventory_counts.checkTransition(
        currentCount,
        finalizedCountPayload,
      ),
    ).toBe('accepted');
    expect(() => {
      db.prepare(
        "UPDATE inventory_counts SET status = 'finalized', finalized_at_ms = ?, finalized_by_user_id = ? WHERE id = ?",
      ).run(nowMs, userId, countId);
    }).not.toThrow();

    currentCount = db.prepare('SELECT * FROM inventory_counts WHERE id = ?').get(countId) as Record<
      string,
      unknown
    >;

    // 5b. Duplicate: finalized -> finalized
    expect(
      MONOTONE_TRANSITION_RULES.inventory_counts.checkTransition(
        currentCount,
        finalizedCountPayload,
      ),
    ).toBe('duplicate');

    // 5c. Illegal: finalized -> open
    const reopenCountPayload = { ...currentCount, status: 'open' };
    expect(
      MONOTONE_TRANSITION_RULES.inventory_counts.checkTransition(currentCount, reopenCountPayload),
    ).toBe('rejected');
    expect(() => {
      db.prepare("UPDATE inventory_counts SET status = 'open' WHERE id = ?").run(countId);
    }).toThrow();

    // ========================================================================
    // 6. inventory_count_lines: count_id immutable
    // ========================================================================
    const count2Id = '018bcfe5-6800-7000-8000-000000000062';
    db.prepare(
      `
      INSERT INTO inventory_counts (id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms, status, started_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
    `,
    ).run(count2Id, orgId, storeId, deviceId, hlc0, nowMs, nowMs, userId);

    const lineId = '018bcfe5-6800-7000-8000-000000000071';
    const prodId = '018bcfe5-6800-7000-8000-000000000072';

    // Seed product for line foreign key
    db.prepare(
      `
      INSERT INTO products (id, organization_id, device_id, hlc, created_at_ms, updated_at_ms, name, name_search, unit, unlimited, has_variants, track_batches, sale_price, vat_rate_bp)
      VALUES (?, ?, ?, ?, ?, ?, 'Test Product', 'test product', 'dona', 0, 0, 0, 1000, 1200)
    `,
    ).run(prodId, orgId, deviceId, hlc0, nowMs, nowMs);

    db.prepare(
      `
      INSERT INTO inventory_count_lines (id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms, count_id, product_id, expected_qty_at_count, counted_qty, adjustment_qty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 10000, 9000, -1000)
    `,
    ).run(lineId, orgId, storeId, deviceId, hlc0, nowMs, nowMs, count2Id, prodId);

    const initialLine = db
      .prepare('SELECT * FROM inventory_count_lines WHERE id = ?')
      .get(lineId) as Record<string, unknown>;

    // 6a. Allowed: update counted_qty / adjustment_qty
    const updatedLinePayload = { ...initialLine, counted_qty: 9500, adjustment_qty: -500 };
    expect(
      MONOTONE_TRANSITION_RULES.inventory_count_lines.checkTransition(
        initialLine,
        updatedLinePayload,
      ),
    ).toBe('accepted');
    expect(() => {
      db.prepare(
        'UPDATE inventory_count_lines SET counted_qty = 9500, adjustment_qty = -500 WHERE id = ?',
      ).run(lineId);
    }).not.toThrow();

    // 6b. Illegal: moving line to a different count
    const illegalMovePayload = { ...initialLine, count_id: '018bcfe5-6800-7000-8000-000000000099' };
    expect(
      MONOTONE_TRANSITION_RULES.inventory_count_lines.checkTransition(
        initialLine,
        illegalMovePayload,
      ),
    ).toBe('rejected');
    expect(() => {
      db.prepare(
        "UPDATE inventory_count_lines SET count_id = '018bcfe5-6800-7000-8000-000000000099' WHERE id = ?",
      ).run(lineId);
    }).toThrow();

    conn.close();
  });

  it('T3.3 fiscal_docs (7th MONOTONE table): SQLite triggers, cloud rule and domain table agree on all 36 status pairs', () => {
    const conn = openLocalSqliteDatabase(':memory:');
    migrateLocalDatabase(conn.db);
    const db = conn.sqlite;
    const orgId = '018bcfe5-6800-7000-8000-000000000001';
    const storeId = '018bcfe5-6800-7000-8000-000000000011';
    const deviceId = '018bcfe5-6800-7000-8000-000000000111';
    const userId = '018bcfe5-6800-7000-8000-000000000003';
    const hlc0 = '001700000000000:00000:018bcfe5-6800-7000-8000-000000000111';
    const nowMs = 1700000000000n;
    const shiftId = '018bcfe5-6800-7000-8000-000000000922';
    db.prepare(
      `INSERT INTO users (id, organization_id, device_id, hlc, created_at_ms, updated_at_ms, username, full_name, role, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 'test_user', 'Test User', 'owner', 1)`,
    ).run(userId, orgId, deviceId, hlc0, nowMs, nowMs);
    db.prepare(
      `INSERT INTO shifts (id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms, shift_no, shift_code, status, opened_by_user_id, opening_cash, opened_at_ms, open_client_request_id, open_request_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'SHF-901', 'open', ?, 0, ?, '018bcfe5-6800-7000-8000-000000000923', 'hash123456')`,
    ).run(shiftId, orgId, storeId, deviceId, hlc0, nowMs, nowMs, userId, nowMs);

    /** Column values a row in `status` must carry to satisfy the CHECKs. */
    const fieldsFor = (status: FiscalDocStatus) => ({
      sent_at_ms: status === 'pending' ? null : nowMs,
      confirmed_at_ms: status === 'confirmed' ? nowMs : null,
      cancelled_at_ms: status === 'cancelled' ? nowMs : null,
      fiscal_sign: status === 'confirmed' ? 'SINOV-FB-1' : null,
      fiscal_number: status === 'confirmed' ? 'SINOV-FD-1' : null,
      qr_payload: status === 'confirmed' ? 'SINOV|q' : null,
    });
    let n = 0;
    const insertDoc = (status: FiscalDocStatus): string => {
      n += 1;
      const id = `018bcfe5-6800-7000-8000-${(0x900000000000 + n).toString(16).padStart(12, '0')}`;
      const f = fieldsFor(status);
      db.prepare(
        `INSERT INTO fiscal_docs (id, organization_id, store_id, device_id, hlc, created_at_ms, updated_at_ms,
           doc_kind, shift_id, idempotency_key, status, attempts, next_check_at_ms, sent_at_ms, confirmed_at_ms,
           cancelled_at_ms, fiscal_sign, fiscal_number, qr_payload, driver_id, offline_deadline_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'shift_open', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'fake', ?)`,
      ).run(
        id,
        orgId,
        storeId,
        deviceId,
        hlc0,
        nowMs,
        nowMs,
        shiftId,
        `k-${n}`,
        status,
        nowMs,
        f.sent_at_ms,
        f.confirmed_at_ms,
        f.cancelled_at_ms,
        f.fiscal_sign,
        f.fiscal_number,
        f.qr_payload,
        nowMs + 86_400_000n,
      );
      return id;
    };
    const rule = MONOTONE_TRANSITION_RULES.fiscal_docs;
    const row = (id: string) =>
      db.prepare('SELECT * FROM fiscal_docs WHERE id = ?').get(id) as Record<string, unknown>;
    for (const from of FISCAL_DOC_STATUSES) {
      for (const to of FISCAL_DOC_STATUSES) {
        const id = insertDoc(from);
        const existing = row(id);
        const f = fieldsFor(to);
        const attempts = from === to ? 2 : 1;
        const incoming = { ...existing, status: to, ...f, attempts };
        const cloud = rule.checkTransition(existing, incoming);
        let localError: unknown = null;
        try {
          db.prepare(
            `UPDATE fiscal_docs SET status = ?, attempts = ?, sent_at_ms = ?, confirmed_at_ms = ?, cancelled_at_ms = ?,
               fiscal_sign = ?, fiscal_number = ?, qr_payload = ? WHERE id = ?`,
          ).run(
            to,
            attempts,
            f.sent_at_ms,
            f.confirmed_at_ms,
            f.cancelled_at_ms,
            f.fiscal_sign,
            f.fiscal_number,
            f.qr_payload,
            id,
          );
        } catch (e) {
          localError = e;
        }
        const live = from === 'pending' || from === 'sent' || from === 'failed';
        const expectedOk = from === to ? live : isFiscalDocTransitionAllowed(from, to);
        expect(localError === null, `sqlite ${from}->${to}`).toBe(expectedOk);
        if (!expectedOk) {
          // Must be the MONOTONE trigger, not merely a CHECK constraint.
          expect(String(localError), `${from}->${to}`).toContain('MONOTONE table "fiscal_docs"');
        }
        if (from === to && !live) {
          expect(cloud, `cloud ${from}->${to}`).toBe('duplicate');
        } else {
          expect(cloud, `cloud ${from}->${to}`).toBe(expectedOk ? 'accepted' : 'rejected');
        }
      }
    }
    // Opaque fields: cloud rejects confirmed without them and any opaque field on a non-confirmed state.
    const sentId = insertDoc('sent');
    const sentRow = row(sentId);
    expect(
      rule.checkTransition(sentRow, { ...sentRow, status: 'confirmed', confirmed_at_ms: nowMs }),
    ).toBe('rejected');
    expect(rule.checkTransition(sentRow, { ...sentRow, status: 'failed', fiscal_sign: 'X' })).toBe(
      'rejected',
    );
    // Attempts never decrease (both sides).
    expect(rule.checkTransition(sentRow, { ...sentRow, attempts: 0 })).toBe('rejected');
    expect(() =>
      db.prepare('UPDATE fiscal_docs SET attempts = 0 WHERE id = ?').run(sentId),
    ).toThrow('MONOTONE table "fiscal_docs"');
    // Immutable core and no physical delete.
    expect(() =>
      db.prepare(`UPDATE fiscal_docs SET idempotency_key = 'other' WHERE id = ?`).run(sentId),
    ).toThrow('MONOTONE table "fiscal_docs"');
    expect(() => db.prepare('DELETE FROM fiscal_docs WHERE id = ?').run(sentId)).toThrow();
    conn.close();
  });
});
