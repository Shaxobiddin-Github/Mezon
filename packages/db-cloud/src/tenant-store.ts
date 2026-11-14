import {
  DomainError,
  type UnixMs,
  type UuidV7,
  normalizeCloudLogin,
  parseUuidV7,
} from '@mezon/domain';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { withPgTenantContext } from './connection.js';
import { cloudOrganizations, cloudStores, cloudUsers } from './schema/tables.js';

export interface CreateOrganizationParams {
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly ownerUserId: UuidV7;
  readonly loginIdentityId: UuidV7;
  readonly organizationName: string;
  readonly storeName: string;
  readonly storeCode: string;
  readonly ownerUsername: string;
  readonly ownerLogin: string;
  readonly passwordHash: string;
  readonly nowMs: UnixMs;
}

export class CloudTenantStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Bootstraps an organization, its default store, owner user, and login identity.
   * Runs under an unconstrained client (mezon_admin) for initial provisioning.
   */
  async createOrganizationWithStoreAndOwner(params: CreateOrganizationParams): Promise<{
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly ownerUserId: UuidV7;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Organization
      await client.query(
        `INSERT INTO cloud_organizations (id, organization_id, name, status, created_at_ms, updated_at_ms)
         VALUES ($1, $2, $3, 'active', $4, $5)`,
        [
          params.organizationId,
          params.organizationId,
          params.organizationName.trim(),
          params.nowMs,
          params.nowMs,
        ],
      );

      // 2. Default Store
      await client.query(
        `INSERT INTO cloud_stores (id, organization_id, name, code, is_active, created_at_ms, updated_at_ms)
         VALUES ($1, $2, $3, $4, true, $5, $6)`,
        [
          params.storeId,
          params.organizationId,
          params.storeName.trim(),
          params.storeCode.trim(),
          params.nowMs,
          params.nowMs,
        ],
      );

      // 3. Owner User
      await client.query(
        `INSERT INTO cloud_users (id, organization_id, username, role, status, failed_login_attempts, created_at_ms, updated_at_ms)
         VALUES ($1, $2, $3, 'owner', 'active', 0, $4, $5)`,
        [
          params.ownerUserId,
          params.organizationId,
          params.ownerUsername.trim(),
          params.nowMs,
          params.nowMs,
        ],
      );

      // 4. Global Login Identity (C1, S3)
      await client.query(
        `INSERT INTO cloud_login_identities (id, login, org_id, user_id, password_hash, created_at_ms, updated_at_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          params.loginIdentityId,
          normalizeCloudLogin(params.ownerLogin),
          params.organizationId,
          params.ownerUserId,
          params.passwordHash,
          params.nowMs,
          params.nowMs,
        ],
      );

      await client.query('COMMIT');
      return {
        organizationId: params.organizationId,
        storeId: params.storeId,
        ownerUserId: params.ownerUserId,
      };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async getOrganization(
    organizationId: UuidV7,
  ): Promise<{ id: UuidV7; name: string; status: string } | null> {
    return withPgTenantContext(this.pool, organizationId, async (tx) => {
      const rows = await tx
        .select()
        .from(cloudOrganizations)
        .where(eq(cloudOrganizations.id, organizationId))
        .limit(1);

      if (rows.length === 0) return null;
      return {
        id: parseUuidV7(rows[0].id),
        name: rows[0].name,
        status: rows[0].status,
      };
    });
  }

  async listStores(organizationId: UuidV7): Promise<
    Array<{
      id: UuidV7;
      organizationId: UuidV7;
      name: string;
      code: string;
      isActive: boolean;
      createdAtMs: number;
      updatedAtMs: number;
    }>
  > {
    return withPgTenantContext(this.pool, organizationId, async (tx) => {
      const rows = await tx.select().from(cloudStores);
      return rows.map((r) => ({
        id: parseUuidV7(r.id),
        organizationId: parseUuidV7(r.organizationId),
        name: r.name,
        code: r.code,
        isActive: r.isActive,
        createdAtMs: Number(r.createdAtMs),
        updatedAtMs: Number(r.updatedAtMs),
      }));
    });
  }

  async createStore(params: {
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly name: string;
    readonly code: string;
    readonly nowMs: UnixMs;
  }): Promise<{
    id: UuidV7;
    organizationId: UuidV7;
    name: string;
    code: string;
    isActive: boolean;
    createdAtMs: bigint;
    updatedAtMs: bigint;
  }> {
    return withPgTenantContext(this.pool, params.organizationId, async (tx) => {
      const existing = await tx
        .select({ id: cloudStores.id })
        .from(cloudStores)
        .where(eq(cloudStores.code, params.code.trim()))
        .limit(1);

      if (existing.length > 0) {
        throw new DomainError('VALIDATION_ERROR', `Store code "${params.code}" already exists`);
      }

      await tx.insert(cloudStores).values({
        id: params.storeId,
        organizationId: params.organizationId,
        name: params.name.trim(),
        code: params.code.trim(),
        isActive: true,
        createdAtMs: params.nowMs,
        updatedAtMs: params.nowMs,
      });

      return {
        id: params.storeId,
        organizationId: params.organizationId,
        name: params.name.trim(),
        code: params.code.trim(),
        isActive: true,
        createdAtMs: BigInt(params.nowMs),
        updatedAtMs: BigInt(params.nowMs),
      };
    });
  }

  async getUserById(
    organizationId: UuidV7,
    userId: UuidV7,
  ): Promise<{
    id: UuidV7;
    organizationId: UuidV7;
    username: string;
    role: 'owner' | 'manager';
    status: 'active' | 'blocked';
    hubUserId: UuidV7 | null;
  } | null> {
    return withPgTenantContext(this.pool, organizationId, async (tx) => {
      const rows = await tx.select().from(cloudUsers).where(eq(cloudUsers.id, userId)).limit(1);

      if (rows.length === 0) return null;
      const u = rows[0];
      return {
        id: parseUuidV7(u.id),
        organizationId: parseUuidV7(u.organizationId),
        username: u.username,
        role: u.role as 'owner' | 'manager',
        status: u.status as 'active' | 'blocked',
        hubUserId: u.hubUserId ? parseUuidV7(u.hubUserId) : null,
      };
    });
  }
}
