import { text, uniqueIndex } from 'drizzle-orm/pg-core';
import { pgBigint, pgBoolean, pgInt } from '../columns.js';
import { cloudSchemaRegistry } from './registry-instance.js';

export const cloudOrganizations = cloudSchemaRegistry.defineTable(
  {
    name: 'cloud_organizations',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
  }),
);

export const cloudStores = cloudSchemaRegistry.defineTable(
  {
    name: 'cloud_stores',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    name: text('name').notNull(),
    code: text('code').notNull(),
    isActive: pgBoolean('is_active').notNull().default(true),
  }),
  (self) => [uniqueIndex('uidx_cloud_stores_org_code').on(self.organizationId, self.code)],
);

export const cloudUsers = cloudSchemaRegistry.defineTable(
  {
    name: 'cloud_users',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    hubUserId: text('hub_user_id'),
    username: text('username').notNull(),
    role: text('role').notNull(), // 'owner' | 'manager'
    status: text('status').notNull().default('active'), // 'active' | 'blocked'
    failedLoginAttempts: pgInt('failed_login_attempts').notNull().default(0),
    lockedUntilMs: pgBigint('locked_until_ms'),
  }),
  (self) => [uniqueIndex('uidx_cloud_users_org_username').on(self.organizationId, self.username)],
);

export const cloudRefreshTokens = cloudSchemaRegistry.defineTable(
  {
    name: 'cloud_refresh_tokens',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    userId: text('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAtMs: pgBigint('expires_at_ms').notNull(),
    revokedAtMs: pgBigint('revoked_at_ms'),
  }),
  (self) => [uniqueIndex('uidx_cloud_refresh_tokens_hash').on(self.organizationId, self.tokenHash)],
);

/**
 * Global pre-auth login table (C1 requirement).
 * Accessible ONLY via SECURITY DEFINER function `auth_lookup_login(login)`.
 * Direct SELECT/INSERT/UPDATE by `mezon_app` is forbidden (REVOKE ALL).
 */
export const cloudLoginIdentities = cloudSchemaRegistry.defineTable(
  {
    name: 'cloud_login_identities',
    tableClass: 'LOCAL',
    tenantScope: 'none',
  },
  (common) => ({
    ...common,
    login: text('login').notNull(),
    orgId: text('org_id').notNull(),
    userId: text('user_id').notNull(),
    passwordHash: text('password_hash').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_cloud_login_identities_login').on(self.login),
    uniqueIndex('uidx_cloud_login_identities_user').on(self.orgId, self.userId),
  ],
);
