import { index, text, uniqueIndex } from 'drizzle-orm/pg-core';
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

export const cloudDevicePairingCodes = cloudSchemaRegistry.defineTable(
  {
    name: 'cloud_device_pairing_codes',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    storeId: text('store_id').notNull(),
    deviceName: text('device_name').notNull(),
    codeHash: text('code_hash').notNull(),
    attemptsLeft: pgInt('attempts_left').notNull().default(5),
    expiresAtMs: pgBigint('expires_at_ms').notNull(),
    usedAtMs: pgBigint('used_at_ms'),
  }),
  (self) => [
    uniqueIndex('uidx_cloud_device_pairing_codes_hash').on(self.codeHash),
    index('idx_cloud_device_pairing_codes_org_store').on(self.organizationId, self.storeId),
  ],
);

export const cloudDevices = cloudSchemaRegistry.defineTable(
  {
    name: 'cloud_devices',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    storeId: text('store_id').notNull(),
    deviceId: text('device_id').notNull(),
    name: text('name').notNull(),
    platform: text('platform').notNull(), // 'windows' | 'android' | 'linux'
    appVersion: text('app_version').notNull(),
    status: text('status').notNull().default('active'), // 'active' | 'blocked' | 'revoked'
    lastSeenAtMs: pgBigint('last_seen_at_ms').notNull(),
  }),
  (self) => [
    uniqueIndex('uidx_cloud_devices_org_device').on(self.organizationId, self.deviceId),
    index('idx_cloud_devices_device_id').on(self.deviceId),
  ],
);

export const cloudDeviceTokens = cloudSchemaRegistry.defineTable(
  {
    name: 'cloud_device_tokens',
    tableClass: 'LOCAL',
    tenantScope: 'organization',
  },
  (common) => ({
    ...common,
    deviceId: text('device_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    clientRequestId: text('client_request_id'),
    expiresAtMs: pgBigint('expires_at_ms').notNull(),
    revokedAtMs: pgBigint('revoked_at_ms'),
    graceUntilMs: pgBigint('grace_until_ms'),
    replacedByTokenId: text('replaced_by_token_id'),
  }),
  (self) => [
    uniqueIndex('uidx_cloud_device_tokens_hash').on(self.organizationId, self.tokenHash),
    index('idx_cloud_device_tokens_client_req').on(self.organizationId, self.clientRequestId),
  ],
);
