import type { UnixMs, UuidV7 } from '@mezon/domain';
import type pg from 'pg';
import { withPgTenantContext } from './connection.js';

export interface StoredLicence {
  readonly licenceId: string;
  readonly envelope: unknown;
}

export interface StoredPlatformInvoice {
  readonly id: string;
  readonly period: string;
  readonly plan: string;
  readonly amountTiyin: bigint;
  readonly status: 'issued' | 'paid' | 'void';
  readonly paidAtMs: bigint | null;
}

export interface GrowthUsage {
  readonly stores: number;
  readonly devices: number;
}

/** T4.7 persistence; verification and status live in the cloud's licence service. */
export class CloudLicenceStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly idGen: { nextId(): UuidV7 },
  ) {}

  /** Stores an already-verified envelope (ops CLI). Re-importing the same licence is a no-op. */
  async saveLicence(params: {
    readonly organizationId: UuidV7;
    readonly licenceId: string;
    readonly plan: string;
    readonly envelope: unknown;
    readonly validFromMs: bigint;
    readonly validUntilMs: bigint;
    readonly nowMs: UnixMs;
  }): Promise<boolean> {
    return withPgTenantContext(this.pool, params.organizationId, async (_tx, client) => {
      const res = await client.query(
        `INSERT INTO cloud_licences (id, organization_id, created_at_ms, updated_at_ms, licence_id,
           plan, envelope_json, valid_from_ms, valid_until_ms)
         VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (organization_id, licence_id) DO NOTHING`,
        [
          this.idGen.nextId(),
          params.organizationId,
          String(params.nowMs),
          params.licenceId,
          params.plan,
          JSON.stringify(params.envelope),
          String(params.validFromMs),
          String(params.validUntilMs),
        ],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }

  async listLicences(organizationId: UuidV7): Promise<StoredLicence[]> {
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const res = await client.query<{ licence_id: string; envelope_json: string }>(
        `SELECT licence_id, envelope_json FROM cloud_licences
          WHERE organization_id = $1 AND revoked_at_ms IS NULL
          ORDER BY valid_until_ms DESC LIMIT 50`,
        [organizationId],
      );
      return res.rows.map((r) => ({
        licenceId: r.licence_id,
        envelope: JSON.parse(r.envelope_json) as unknown,
      }));
    });
  }

  async getOrganizationCreatedAtMs(organizationId: UuidV7): Promise<bigint> {
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const res = await client.query<{ created_at_ms: string }>(
        'SELECT created_at_ms FROM cloud_organizations WHERE organization_id = $1 LIMIT 1',
        [organizationId],
      );
      const row = res.rows[0];
      if (!row) throw new Error('Organization not found');
      return BigInt(row.created_at_ms);
    });
  }

  /** Active stores and active (non-revoked) devices, i.e. what the plan limits count. */
  async getUsage(organizationId: UuidV7): Promise<GrowthUsage> {
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const res = await client.query<{ stores: string; devices: string }>(
        `SELECT
           (SELECT count(*) FROM cloud_stores WHERE organization_id = $1 AND is_active = true) AS stores,
           (SELECT count(*) FROM cloud_devices WHERE organization_id = $1 AND status = 'active') AS devices`,
        [organizationId],
      );
      const row = res.rows[0];
      return { stores: Number(row?.stores ?? 0), devices: Number(row?.devices ?? 0) };
    });
  }

  /** Issues the month's platform invoice once (idempotent per organization and period). */
  async issueInvoice(params: {
    readonly organizationId: UuidV7;
    readonly period: string;
    readonly plan: string;
    readonly amountTiyin: bigint;
    readonly nowMs: UnixMs;
  }): Promise<boolean> {
    return withPgTenantContext(this.pool, params.organizationId, async (_tx, client) => {
      const res = await client.query(
        `INSERT INTO cloud_platform_invoices (id, organization_id, created_at_ms, updated_at_ms,
           period, plan, amount_tiyin, status)
         VALUES ($1, $2, $3, $3, $4, $5, $6, 'issued')
         ON CONFLICT (organization_id, period) DO NOTHING`,
        [
          this.idGen.nextId(),
          params.organizationId,
          String(params.nowMs),
          params.period,
          params.plan,
          String(params.amountTiyin),
        ],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }

  async markInvoicePaid(organizationId: UuidV7, period: string, nowMs: UnixMs): Promise<boolean> {
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const res = await client.query(
        `UPDATE cloud_platform_invoices SET status = 'paid', paid_at_ms = $3, updated_at_ms = $3
          WHERE organization_id = $1 AND period = $2 AND status = 'issued'`,
        [organizationId, period, String(nowMs)],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }

  async listInvoices(organizationId: UuidV7): Promise<StoredPlatformInvoice[]> {
    return withPgTenantContext(this.pool, organizationId, async (_tx, client) => {
      const res = await client.query<{
        id: string;
        period: string;
        plan: string;
        amount_tiyin: string;
        status: 'issued' | 'paid' | 'void';
        paid_at_ms: string | null;
      }>(
        `SELECT id, period, plan, amount_tiyin, status, paid_at_ms FROM cloud_platform_invoices
          WHERE organization_id = $1 ORDER BY period DESC LIMIT 24`,
        [organizationId],
      );
      return res.rows.map((r) => ({
        id: r.id,
        period: r.period,
        plan: r.plan,
        amountTiyin: BigInt(r.amount_tiyin),
        status: r.status,
        paidAtMs: r.paid_at_ms === null ? null : BigInt(r.paid_at_ms),
      }));
    });
  }
}
