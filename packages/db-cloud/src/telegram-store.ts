import { createHash, randomBytes } from 'node:crypto';
import { DomainError, type UnixMs, type UuidV7, parseUuidV7 } from '@mezon/domain';
import type pg from 'pg';
import { withPgTenantContext } from './connection.js';
import { loadCustomerDebts } from './customer-debt.js';

export type TelegramLinkKind = 'staff' | 'customer';
export type TelegramLocale = 'uz-Latn' | 'uz-Cyrl' | 'ru';
export type TelegramDeliveryKind = 'digest' | 'debt_reminder';

/** One-time link codes live 15 minutes. */
export const TELEGRAM_LINK_CODE_TTL_MS = 15n * 60n * 1000n;

export interface ConsumedLinkCode {
  readonly organizationId: UuidV7;
  readonly kind: TelegramLinkKind;
  readonly userId: string | null;
  readonly customerId: string | null;
}

export interface TelegramStaffTarget {
  readonly linkId: string;
  readonly chatId: string;
  readonly locale: TelegramLocale;
  readonly userId: string;
}

export interface TelegramDebtTarget {
  readonly linkId: string;
  readonly chatId: string;
  readonly locale: TelegramLocale;
  readonly customerId: string;
  readonly customerName: string;
  readonly balanceTiyin: bigint;
  readonly overdueTiyin: bigint;
}

export interface TelegramStaffLinkStatus {
  readonly linked: boolean;
  readonly linkedAtMs: UnixMs | null;
}

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

/**
 * Link code = `<organization id hex, 32>_<secret, 22 base64url>` (55 chars, fits Telegram's
 * 64-char `/start` payload limit). The organization part selects the tenant context, as the
 * tenant-prefixed refresh token does (T2.1); only the secret's hash is stored.
 */
export function parseTelegramLinkCode(code: string): { organizationId: UuidV7; secret: string } {
  const m = /^([0-9a-f]{32})_([A-Za-z0-9_-]{22})$/.exec(code.trim());
  if (!m?.[1] || !m[2]) throw new DomainError('VALIDATION_ERROR', 'Invalid link code');
  const h = m[1];
  const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return { organizationId: parseUuidV7(uuid), secret: m[2] };
}

/** A transiently failed Telegram delivery is retried once, not earlier than this. */
export const TELEGRAM_RETRY_AFTER_MS = 15n * 60_000n;

export class CloudTelegramStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly idGen: { nextId(): UuidV7 },
  ) {}

  async issueLinkCode(params: {
    readonly organizationId: UuidV7;
    readonly kind: TelegramLinkKind;
    readonly userId?: string;
    readonly customerId?: string;
    readonly nowMs: UnixMs;
  }): Promise<{ code: string; expiresAtMs: bigint }> {
    const secret = randomBytes(16).toString('base64url');
    const expiresAtMs = BigInt(params.nowMs) + TELEGRAM_LINK_CODE_TTL_MS;
    await withPgTenantContext(this.pool, params.organizationId, async (_tx, client) => {
      if (params.kind === 'customer') {
        const exists = await client.query(
          'SELECT 1 FROM customers WHERE organization_id = $1 AND id = $2 AND deleted_at_ms IS NULL',
          [params.organizationId, params.customerId],
        );
        if (exists.rowCount === 0)
          throw new DomainError('CUSTOMER_NOT_FOUND', 'Customer not found');
      }
      await client.query(
        `INSERT INTO cloud_telegram_link_codes
           (id, organization_id, created_at_ms, updated_at_ms, kind, user_id, customer_id, code_hash, expires_at_ms)
         VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8)`,
        [
          this.idGen.nextId(),
          params.organizationId,
          String(params.nowMs),
          params.kind,
          params.kind === 'staff' ? params.userId : null,
          params.kind === 'customer' ? params.customerId : null,
          hashSecret(secret),
          String(expiresAtMs),
        ],
      );
    });
    return { code: `${params.organizationId.replaceAll('-', '')}_${secret}`, expiresAtMs };
  }

  /** Marks the code used and returns its target, or null when unknown, expired or used. */
  async consumeLinkCode(code: string, nowMs: UnixMs): Promise<ConsumedLinkCode | null> {
    let parsed: { organizationId: UuidV7; secret: string };
    try {
      parsed = parseTelegramLinkCode(code);
    } catch {
      return null;
    }
    return withPgTenantContext(this.pool, parsed.organizationId, async (_tx, client) => {
      const res = await client.query<{
        id: string;
        kind: TelegramLinkKind;
        user_id: string | null;
        customer_id: string | null;
      }>(
        `UPDATE cloud_telegram_link_codes
            SET used_at_ms = $3, updated_at_ms = $3
          WHERE organization_id = $1 AND code_hash = $2
            AND used_at_ms IS NULL AND expires_at_ms > $3
          RETURNING id, kind, user_id, customer_id`,
        [parsed.organizationId, hashSecret(parsed.secret), String(nowMs)],
      );
      const row = res.rows[0];
      if (!row) return null;
      if (row.kind === 'staff') {
        // Only an active owner/manager may receive business figures.
        const u = await client.query(
          `SELECT 1 FROM cloud_users WHERE organization_id = $1 AND id = $2
              AND status = 'active' AND role IN ('owner', 'manager')`,
          [parsed.organizationId, row.user_id],
        );
        if (u.rowCount === 0) return null;
      }
      return {
        organizationId: parsed.organizationId,
        kind: row.kind,
        userId: row.user_id,
        customerId: row.customer_id,
      };
    });
  }

  /**
   * Binds a chat to the code's target, replacing an older binding of the same target.
   * Staff bindings are consented by the owner's own action; customer bindings start without
   * consent and receive nothing until the customer presses "Yes".
   */
  async bindChat(params: {
    readonly target: ConsumedLinkCode;
    readonly chatId: string;
    readonly locale: TelegramLocale;
    readonly nowMs: UnixMs;
  }): Promise<{ linkId: string }> {
    const t = params.target;
    return withPgTenantContext(this.pool, t.organizationId, async (_tx, client) => {
      await client.query(
        `UPDATE cloud_telegram_links SET revoked_at_ms = $4, updated_at_ms = $4
          WHERE organization_id = $1 AND revoked_at_ms IS NULL AND kind = $2
            AND COALESCE(user_id, customer_id) = $3`,
        [t.organizationId, t.kind, t.userId ?? t.customerId, String(params.nowMs)],
      );
      const linkId = this.idGen.nextId();
      await client.query(
        `INSERT INTO cloud_telegram_links
           (id, organization_id, created_at_ms, updated_at_ms, kind, user_id, customer_id, chat_id, locale, consent_at_ms)
         VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9)`,
        [
          linkId,
          t.organizationId,
          String(params.nowMs),
          t.kind,
          t.userId,
          t.customerId,
          params.chatId,
          params.locale,
          t.kind === 'staff' ? String(params.nowMs) : null,
        ],
      );
      return { linkId };
    });
  }

  /** Customer consent from the inline button; only the bound chat may answer. */
  async setCustomerConsent(params: {
    readonly organizationId: UuidV7;
    readonly linkId: string;
    readonly chatId: string;
    readonly consent: boolean;
    readonly nowMs: UnixMs;
  }): Promise<boolean> {
    return withPgTenantContext(this.pool, params.organizationId, async (_tx, client) => {
      const res = await client.query(
        params.consent
          ? `UPDATE cloud_telegram_links SET consent_at_ms = $4, updated_at_ms = $4
              WHERE organization_id = $1 AND id = $2 AND chat_id = $3
                AND kind = 'customer' AND revoked_at_ms IS NULL`
          : `UPDATE cloud_telegram_links SET revoked_at_ms = $4, consent_at_ms = NULL, updated_at_ms = $4
              WHERE organization_id = $1 AND id = $2 AND chat_id = $3
                AND kind = 'customer' AND revoked_at_ms IS NULL`,
        [params.organizationId, params.linkId, params.chatId, String(params.nowMs)],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }

  /**
   * Consent button: the callback carries only the link id, so the organization is found from the
   * chat (`telegram_orgs_for_chat`); the update matches only when the link belongs to that chat.
   */
  async setCustomerConsentByChat(params: {
    readonly chatId: string;
    readonly linkId: string;
    readonly consent: boolean;
    readonly nowMs: UnixMs;
  }): Promise<boolean> {
    const orgs = await this.pool.query<{ organization_id: string }>(
      'SELECT organization_id FROM telegram_orgs_for_chat($1)',
      [params.chatId],
    );
    for (const { organization_id } of orgs.rows) {
      const ok = await this.setCustomerConsent({
        organizationId: parseUuidV7(organization_id),
        linkId: params.linkId,
        chatId: params.chatId,
        consent: params.consent,
        nowMs: params.nowMs,
      });
      if (ok) return true;
    }
    return false;
  }

  /** `/stop`: revokes every active binding of the chat in every organization. */
  async revokeChat(chatId: string, nowMs: UnixMs): Promise<number> {
    const orgs = await this.pool.query<{ organization_id: string }>(
      'SELECT organization_id FROM telegram_orgs_for_chat($1)',
      [chatId],
    );
    let revoked = 0;
    for (const { organization_id } of orgs.rows) {
      const org = parseUuidV7(organization_id);
      revoked += await withPgTenantContext(this.pool, org, async (_tx, client) => {
        const res = await client.query(
          `UPDATE cloud_telegram_links SET revoked_at_ms = $3, updated_at_ms = $3
            WHERE organization_id = $1 AND chat_id = $2 AND revoked_at_ms IS NULL`,
          [org, chatId, String(nowMs)],
        );
        return res.rowCount ?? 0;
      });
    }
    return revoked;
  }

  async revokeLink(organizationId: UuidV7, linkId: string, nowMs: UnixMs): Promise<void> {
    await withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      await client.query(
        `UPDATE cloud_telegram_links SET revoked_at_ms = $3, updated_at_ms = $3
          WHERE organization_id = $1 AND id = $2 AND revoked_at_ms IS NULL`,
        [organizationId, linkId, String(nowMs)],
      );
    });
  }

  async revokeStaffLink(organizationId: UuidV7, userId: string, nowMs: UnixMs): Promise<void> {
    await withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      await client.query(
        `UPDATE cloud_telegram_links SET revoked_at_ms = $3, updated_at_ms = $3
          WHERE organization_id = $1 AND kind = 'staff' AND user_id = $2 AND revoked_at_ms IS NULL`,
        [organizationId, userId, String(nowMs)],
      );
    });
  }

  async getStaffLinkStatus(
    organizationId: UuidV7,
    userId: string,
  ): Promise<TelegramStaffLinkStatus> {
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const res = await client.query<{ created_at_ms: string }>(
        `SELECT created_at_ms FROM cloud_telegram_links
          WHERE organization_id = $1 AND kind = 'staff' AND user_id = $2 AND revoked_at_ms IS NULL`,
        [organizationId, userId],
      );
      const row = res.rows[0];
      return row
        ? { linked: true, linkedAtMs: BigInt(row.created_at_ms) as UnixMs }
        : { linked: false, linkedAtMs: null };
    });
  }

  /** Organizations that have at least one active binding (scheduler entry point). */
  async listActiveOrganizations(): Promise<UuidV7[]> {
    const res = await this.pool.query<{ organization_id: string }>(
      'SELECT organization_id FROM telegram_active_orgs()',
    );
    return res.rows.map((r) => parseUuidV7(r.organization_id));
  }

  /** Active owner/manager bindings whose user is still active with that role. */
  async listStaffTargets(organizationId: UuidV7): Promise<TelegramStaffTarget[]> {
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const res = await client.query<{
        id: string;
        chat_id: string;
        locale: TelegramLocale;
        user_id: string;
      }>(
        `SELECT l.id, l.chat_id, l.locale, l.user_id
           FROM cloud_telegram_links l
           JOIN cloud_users u ON u.id = l.user_id::uuid AND u.organization_id = l.organization_id
          WHERE l.organization_id = $1 AND l.kind = 'staff' AND l.revoked_at_ms IS NULL
            AND u.status = 'active' AND u.role IN ('owner', 'manager')`,
        [organizationId],
      );
      return res.rows.map((r) => ({
        linkId: r.id,
        chatId: r.chat_id,
        locale: r.locale,
        userId: r.user_id,
      }));
    });
  }

  /** Consenting customers with debt (same FIFO rule as the hub). */
  async listDebtTargets(params: {
    readonly organizationId: UuidV7;
    readonly asOfMs: UnixMs;
    readonly tz: string;
  }): Promise<TelegramDebtTarget[]> {
    return withPgTenantContext(this.pool, params.organizationId, async (_tx, client) => {
      const res = await client.query<{
        id: string;
        chat_id: string;
        locale: TelegramLocale;
        customer_id: string;
        full_name: string;
      }>(
        `SELECT l.id, l.chat_id, l.locale, l.customer_id, c.full_name
           FROM cloud_telegram_links l
           JOIN customers c ON c.id = l.customer_id::uuid AND c.organization_id = l.organization_id
          WHERE l.organization_id = $1 AND l.kind = 'customer' AND l.revoked_at_ms IS NULL
            AND l.consent_at_ms IS NOT NULL AND c.deleted_at_ms IS NULL`,
        [params.organizationId],
      );
      const debts = await loadCustomerDebts(client, {
        organizationId: params.organizationId,
        customerIds: res.rows.map((r) => r.customer_id),
        asOfMs: params.asOfMs,
        tz: params.tz,
      });
      const out: TelegramDebtTarget[] = [];
      for (const r of res.rows) {
        const d = debts.get(r.customer_id);
        const balance = d ? BigInt(d.balance) : 0n;
        if (balance <= 0n) continue;
        out.push({
          linkId: r.id,
          chatId: r.chat_id,
          locale: r.locale,
          customerId: r.customer_id,
          customerName: r.full_name,
          balanceTiyin: balance,
          overdueTiyin: d ? BigInt(d.overdueAmount) : 0n,
        });
      }
      return out;
    });
  }

  /**
   * Claims a delivery slot before sending. Returns false when the same (link, kind, period)
   * was already claimed, so a digest or reminder is never sent twice (at most once).
   */
  async claimDelivery(params: {
    readonly organizationId: UuidV7;
    readonly linkId: string;
    readonly kind: TelegramDeliveryKind;
    readonly periodKey: string;
    readonly nowMs: UnixMs;
    /** A transient failure older than this is claimed once more (second and last attempt). */
    readonly retryAfterMs?: bigint;
  }): Promise<string | null> {
    return withPgTenantContext(this.pool, params.organizationId, async (_tx, client) => {
      const id = this.idGen.nextId();
      const res = await client.query(
        `INSERT INTO cloud_telegram_deliveries
           (id, organization_id, created_at_ms, updated_at_ms, link_id, kind, period_key, status)
         VALUES ($1, $2, $3, $3, $4, $5, $6, 'claimed')
         ON CONFLICT (organization_id, link_id, kind, period_key) DO NOTHING`,
        [
          id,
          params.organizationId,
          String(params.nowMs),
          params.linkId,
          params.kind,
          params.periodKey,
        ],
      );
      if ((res.rowCount ?? 0) > 0) return id;
      // Owner decision (2026-11-20): one retry of a transient failure, never of a blocked chat.
      // The guarded UPDATE is the claim, so two cloud instances still send at most once more.
      const retry = await client.query<{ id: string }>(
        `UPDATE cloud_telegram_deliveries
            SET status = 'claimed', attempts = attempts + 1, updated_at_ms = $5
          WHERE organization_id = $1 AND link_id = $2 AND kind = $3 AND period_key = $4
            AND status = 'failed' AND attempts < 2
            AND last_error IS DISTINCT FROM 'chatUnavailable'
            AND updated_at_ms <= $6
          RETURNING id`,
        [
          params.organizationId,
          params.linkId,
          params.kind,
          params.periodKey,
          String(params.nowMs),
          String(BigInt(params.nowMs) - (params.retryAfterMs ?? TELEGRAM_RETRY_AFTER_MS)),
        ],
      );
      return retry.rows[0]?.id ?? null;
    });
  }

  async finishDelivery(params: {
    readonly organizationId: UuidV7;
    readonly deliveryId: string;
    readonly status: 'sent' | 'failed';
    readonly error?: string;
    readonly nowMs: UnixMs;
  }): Promise<void> {
    await withPgTenantContext(this.pool, params.organizationId, async (_tx, client) => {
      await client.query(
        `UPDATE cloud_telegram_deliveries SET status = $3, last_error = $4, updated_at_ms = $5
          WHERE organization_id = $1 AND id = $2`,
        [
          params.organizationId,
          params.deliveryId,
          params.status,
          params.error?.slice(0, 500) ?? null,
          String(params.nowMs),
        ],
      );
    });
  }

  /** Customer display data for the consent question (name of the business and of the customer). */
  async getOrganizationName(organizationId: UuidV7): Promise<string> {
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const res = await client.query<{ name: string }>(
        'SELECT name FROM cloud_organizations WHERE organization_id = $1 LIMIT 1',
        [organizationId],
      );
      return res.rows[0]?.name ?? 'Guzar';
    });
  }
}
