import { sql } from 'drizzle-orm';
import { check, index, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { pgBigint } from '../columns.js';
import { cloudSchemaRegistry } from './registry-instance.js';

/**
 * T2.8 Telegram. Cloud-only (`LOCAL`) tables, organization-scoped under RLS.
 *
 * - `cloud_telegram_link_codes`: one-time codes the cabinet issues; only the SHA-256 hash is stored.
 * - `cloud_telegram_links`: chat bindings. Staff = owner/manager (daily digest); customer = debt
 *   reminders, sent only while `consent_at_ms` is set and `revoked_at_ms` is not.
 * - `cloud_telegram_deliveries`: one row per (link, kind, period) claimed before sending, so a
 *   restart or a second scheduler never sends the same digest or reminder twice.
 */
export const cloudTelegramLinkCodes = cloudSchemaRegistry.defineTable(
  { name: 'cloud_telegram_link_codes', tableClass: 'LOCAL', tenantScope: 'organization' },
  (common) => ({
    ...common,
    kind: text('kind').notNull(),
    userId: text('user_id'),
    customerId: text('customer_id'),
    codeHash: text('code_hash').notNull(),
    expiresAtMs: pgBigint('expires_at_ms').notNull(),
    usedAtMs: pgBigint('used_at_ms'),
  }),
  (self) => [
    uniqueIndex('uidx_cloud_telegram_link_codes_hash').on(self.organizationId, self.codeHash),
    check('chk_cloud_telegram_link_codes_kind', sql`${self.kind} IN ('staff', 'customer')`),
    check(
      'chk_cloud_telegram_link_codes_target',
      sql`(${self.kind} = 'staff' AND ${self.userId} IS NOT NULL AND ${self.customerId} IS NULL) OR (${self.kind} = 'customer' AND ${self.customerId} IS NOT NULL AND ${self.userId} IS NULL)`,
    ),
  ],
);

export const cloudTelegramLinks = cloudSchemaRegistry.defineTable(
  { name: 'cloud_telegram_links', tableClass: 'LOCAL', tenantScope: 'organization' },
  (common) => ({
    ...common,
    kind: text('kind').notNull(),
    userId: text('user_id'),
    customerId: text('customer_id'),
    chatId: text('chat_id').notNull(),
    locale: text('locale').notNull().default('uz-Latn'),
    consentAtMs: pgBigint('consent_at_ms'),
    revokedAtMs: pgBigint('revoked_at_ms'),
  }),
  (self) => [
    uniqueIndex('uidx_cloud_telegram_links_staff_active')
      .on(self.organizationId, self.userId)
      .where(sql`${self.kind} = 'staff' AND ${self.revokedAtMs} IS NULL`),
    uniqueIndex('uidx_cloud_telegram_links_customer_active')
      .on(self.organizationId, self.customerId)
      .where(sql`${self.kind} = 'customer' AND ${self.revokedAtMs} IS NULL`),
    index('idx_cloud_telegram_links_chat').on(self.chatId),
    check('chk_cloud_telegram_links_kind', sql`${self.kind} IN ('staff', 'customer')`),
    check(
      'chk_cloud_telegram_links_target',
      sql`(${self.kind} = 'staff' AND ${self.userId} IS NOT NULL AND ${self.customerId} IS NULL) OR (${self.kind} = 'customer' AND ${self.customerId} IS NOT NULL AND ${self.userId} IS NULL)`,
    ),
    check('chk_cloud_telegram_links_locale', sql`${self.locale} IN ('uz-Latn', 'uz-Cyrl', 'ru')`),
    check('chk_cloud_telegram_links_chat', sql`${self.chatId} ~ '^-?[0-9]{1,20}$'`),
  ],
);

export const cloudTelegramDeliveries = cloudSchemaRegistry.defineTable(
  { name: 'cloud_telegram_deliveries', tableClass: 'LOCAL', tenantScope: 'organization' },
  (common) => ({
    ...common,
    linkId: text('link_id').notNull(),
    kind: text('kind').notNull(),
    periodKey: text('period_key').notNull(),
    status: text('status').notNull(),
    lastError: text('last_error'),
  }),
  (self) => [
    uniqueIndex('uidx_cloud_telegram_deliveries_once').on(
      self.organizationId,
      self.linkId,
      self.kind,
      self.periodKey,
    ),
    check('chk_cloud_telegram_deliveries_kind', sql`${self.kind} IN ('digest', 'debt_reminder')`),
    check(
      'chk_cloud_telegram_deliveries_status',
      sql`${self.status} IN ('claimed', 'sent', 'failed')`,
    ),
  ],
);
