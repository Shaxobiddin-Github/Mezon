import {
  DomainError,
  type UnixMs,
  type UuidV7,
  normalizeCloudLogin,
  parseUuidV7,
} from '@mezon/domain';
import { and, eq, isNull } from 'drizzle-orm';
import type pg from 'pg';
import { withPgTenantContext } from './connection.js';
import { cloudRefreshTokens, cloudUsers } from './schema/tables.js';

export interface CloudLoginLookupResult {
  readonly userId: UuidV7;
  readonly organizationId: UuidV7;
  readonly passwordHash: string;
  readonly userStatus: 'active' | 'blocked';
  readonly userRole: 'owner' | 'manager';
  readonly userName: string;
  readonly failedLoginAttempts: number;
  readonly lockedUntilMs: bigint | null;
}

export class CloudAuthStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Pre-auth lookup using SECURITY DEFINER function `auth_lookup_login`.
   * mezon_app role cannot directly query cloud_login_identities (C1 requirement).
   */
  async lookupLogin(login: string): Promise<CloudLoginLookupResult | null> {
    const cleanLogin = normalizeCloudLogin(login);
    const res = await this.pool.query<{
      user_id: string;
      organization_id: string;
      password_hash: string;
      user_status: string;
      user_role: string;
      user_name: string;
      failed_login_attempts: number;
      locked_until_ms: string | number | bigint | null;
    }>(
      `SELECT user_id, organization_id, password_hash, user_status, user_role, user_name, failed_login_attempts, locked_until_ms
       FROM auth_lookup_login($1)
       LIMIT 1`,
      [cleanLogin],
    );

    if (res.rows.length === 0) {
      return null;
    }

    const row = res.rows[0];
    return {
      userId: parseUuidV7(row.user_id),
      organizationId: parseUuidV7(row.organization_id),
      passwordHash: row.password_hash,
      userStatus: row.user_status as 'active' | 'blocked',
      userRole: row.user_role as 'owner' | 'manager',
      userName: row.user_name,
      failedLoginAttempts: Number(row.failed_login_attempts ?? 0),
      lockedUntilMs:
        row.locked_until_ms !== null && row.locked_until_ms !== undefined
          ? BigInt(row.locked_until_ms)
          : null,
    };
  }

  async recordLoginFailure(params: {
    readonly organizationId: UuidV7;
    readonly userId: UuidV7;
    readonly attempts: number;
    readonly lockedUntilMs: UnixMs | null;
    readonly nowMs: UnixMs;
  }): Promise<void> {
    await withPgTenantContext(this.pool, params.organizationId, async (tx) => {
      await tx
        .update(cloudUsers)
        .set({
          failedLoginAttempts: params.attempts,
          lockedUntilMs: params.lockedUntilMs !== null ? BigInt(params.lockedUntilMs) : null,
          updatedAtMs: params.nowMs,
        })
        .where(eq(cloudUsers.id, params.userId));
    });
  }

  async resetLoginFailure(params: {
    readonly organizationId: UuidV7;
    readonly userId: UuidV7;
    readonly nowMs: UnixMs;
  }): Promise<void> {
    await withPgTenantContext(this.pool, params.organizationId, async (tx) => {
      await tx
        .update(cloudUsers)
        .set({
          failedLoginAttempts: 0,
          lockedUntilMs: null,
          updatedAtMs: params.nowMs,
        })
        .where(eq(cloudUsers.id, params.userId));
    });
  }

  async saveRefreshToken(params: {
    readonly organizationId: UuidV7;
    readonly tokenId: UuidV7;
    readonly userId: UuidV7;
    readonly tokenHash: string;
    readonly expiresAtMs: UnixMs;
    readonly nowMs: UnixMs;
  }): Promise<void> {
    await withPgTenantContext(this.pool, params.organizationId, async (tx) => {
      await tx.insert(cloudRefreshTokens).values({
        id: params.tokenId,
        organizationId: params.organizationId,
        userId: params.userId,
        tokenHash: params.tokenHash,
        expiresAtMs: BigInt(params.expiresAtMs),
        revokedAtMs: null,
        createdAtMs: params.nowMs,
        updatedAtMs: params.nowMs,
      });
    });
  }

  /**
   * C2 Rotating refresh token with reuse detection under RLS.
   */
  async rotateRefreshToken(params: {
    readonly organizationId: UuidV7;
    readonly oldTokenHash: string;
    readonly newTokenId: UuidV7;
    readonly newTokenHash: string;
    readonly newExpiresAtMs: UnixMs;
    readonly nowMs: UnixMs;
  }): Promise<{ readonly userId: UuidV7 }> {
    const outcome = await withPgTenantContext(this.pool, params.organizationId, async (tx) => {
      const rows = await tx
        .select()
        .from(cloudRefreshTokens)
        .where(eq(cloudRefreshTokens.tokenHash, params.oldTokenHash))
        .limit(1);

      if (rows.length === 0) {
        throw new DomainError('AUTH_UNAUTHORIZED', 'Invalid refresh token');
      }

      const existing = rows[0];

      // Token reuse detection! If already revoked, invalidate ALL sessions for this user!
      // We must COMMIT this revocation before throwing, so the security wipe persists!
      if (existing.revokedAtMs !== null) {
        await tx
          .update(cloudRefreshTokens)
          .set({
            revokedAtMs: BigInt(params.nowMs),
            updatedAtMs: params.nowMs,
          })
          .where(
            and(
              eq(cloudRefreshTokens.userId, existing.userId),
              isNull(cloudRefreshTokens.revokedAtMs),
            ),
          );

        return { reuseDetected: true as const };
      }

      if (BigInt(existing.expiresAtMs) < BigInt(params.nowMs)) {
        throw new DomainError('AUTH_UNAUTHORIZED', 'Refresh token expired');
      }

      // Mark old token revoked
      await tx
        .update(cloudRefreshTokens)
        .set({
          revokedAtMs: BigInt(params.nowMs),
          updatedAtMs: params.nowMs,
        })
        .where(eq(cloudRefreshTokens.id, existing.id));

      // Issue new token
      await tx.insert(cloudRefreshTokens).values({
        id: params.newTokenId,
        organizationId: params.organizationId,
        userId: existing.userId,
        tokenHash: params.newTokenHash,
        expiresAtMs: BigInt(params.newExpiresAtMs),
        revokedAtMs: null,
        createdAtMs: params.nowMs,
        updatedAtMs: params.nowMs,
      });

      return {
        reuseDetected: false as const,
        userId: parseUuidV7(existing.userId),
      };
    });

    if (outcome.reuseDetected) {
      throw new DomainError(
        'AUTH_UNAUTHORIZED',
        'Refresh token reuse detected — all user sessions revoked',
      );
    }

    return { userId: outcome.userId };
  }

  async revokeRefreshToken(params: {
    readonly organizationId: UuidV7;
    readonly tokenHash: string;
    readonly nowMs: UnixMs;
  }): Promise<void> {
    await withPgTenantContext(this.pool, params.organizationId, async (tx) => {
      await tx
        .update(cloudRefreshTokens)
        .set({
          revokedAtMs: BigInt(params.nowMs),
          updatedAtMs: params.nowMs,
        })
        .where(eq(cloudRefreshTokens.tokenHash, params.tokenHash));
    });
  }
}
