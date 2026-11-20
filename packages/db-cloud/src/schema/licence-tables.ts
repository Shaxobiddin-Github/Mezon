import { sql } from 'drizzle-orm';
import { check, index, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { pgBigint } from '../columns.js';
import { cloudSchemaRegistry } from './registry-instance.js';

/**
 * T4.7 signed licences (`LOCAL`, organization-scoped). The signed envelope is kept verbatim and
 * re-verified on every read; `plan`/`valid_*` columns are only an index, never trusted alone.
 */
export const cloudLicences = cloudSchemaRegistry.defineTable(
  { name: 'cloud_licences', tableClass: 'LOCAL', tenantScope: 'organization' },
  (common) => ({
    ...common,
    licenceId: text('licence_id').notNull(),
    plan: text('plan').notNull(),
    envelopeJson: text('envelope_json').notNull(),
    validFromMs: pgBigint('valid_from_ms').notNull(),
    validUntilMs: pgBigint('valid_until_ms').notNull(),
    revokedAtMs: pgBigint('revoked_at_ms'),
  }),
  (self) => [
    uniqueIndex('uidx_cloud_licences_licence').on(self.organizationId, self.licenceId),
    index('idx_cloud_licences_org_until').on(self.organizationId, self.validUntilMs),
    check('chk_cloud_licences_plan', sql`${self.plan} IN ('start', 'business', 'pro')`),
    check('chk_cloud_licences_range', sql`${self.validUntilMs} > ${self.validFromMs}`),
  ],
);

/** T4.7 platform invoice per organization and month (the platform's fee, not a sale). */
export const cloudPlatformInvoices = cloudSchemaRegistry.defineTable(
  { name: 'cloud_platform_invoices', tableClass: 'LOCAL', tenantScope: 'organization' },
  (common) => ({
    ...common,
    period: text('period').notNull(),
    plan: text('plan').notNull(),
    amountTiyin: pgBigint('amount_tiyin').notNull(),
    status: text('status').notNull(),
    paidAtMs: pgBigint('paid_at_ms'),
  }),
  (self) => [
    uniqueIndex('uidx_cloud_platform_invoices_period').on(self.organizationId, self.period),
    check('chk_cloud_platform_invoices_period', sql`${self.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check('chk_cloud_platform_invoices_plan', sql`${self.plan} IN ('start', 'business', 'pro')`),
    check('chk_cloud_platform_invoices_amount', sql`${self.amountTiyin} >= 0`),
    check('chk_cloud_platform_invoices_status', sql`${self.status} IN ('issued', 'paid', 'void')`),
    check(
      'chk_cloud_platform_invoices_paid',
      sql`(${self.status} = 'paid') = (${self.paidAtMs} IS NOT NULL)`,
    ),
  ],
);
