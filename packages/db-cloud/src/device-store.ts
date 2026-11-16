import { createHash, randomBytes } from 'node:crypto';
import {
  DomainError,
  type IdGenerator,
  type UnixMs,
  type UuidV7,
  parseUuidV7,
} from '@mezon/domain';
import { and, eq, isNull } from 'drizzle-orm';
import type pg from 'pg';
import { withPgTenantContext } from './connection.js';
import {
  cloudDevicePairingCodes,
  cloudDeviceTokens,
  cloudDevices,
  cloudOrganizations,
  cloudStores,
} from './schema/tables.js';

const TEN_MINUTES_MS = 10n * 60n * 1000n;
const NINETY_DAYS_MS = 90n * 24n * 60n * 60n * 1000n;

// Unambiguous alphanumeric alphabet (excludes 0, O, 1, I, L)
const PAIRING_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function generatePairingCode(): string {
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += PAIRING_CHARS[bytes[i] % PAIRING_CHARS.length];
  }
  return code;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export interface PairingCodeLookup {
  readonly pairingCodeId: UuidV7;
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceName: string;
  readonly attemptsLeft: number;
  readonly expiresAtMs: bigint;
  readonly usedAtMs: bigint | null;
}

export interface DeviceOwnerLookup {
  readonly organizationId: UuidV7;
  readonly deviceStatus: string;
}

export interface VerifiedDeviceContext {
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceId: UuidV7;
  readonly deviceName: string;
  readonly status: 'active' | 'blocked' | 'revoked';
}

export class CloudDeviceStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Generates a single-use 8-character pairing code under tenant RLS (cabinet owner).
   */
  async createPairingCode(params: {
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly deviceName: string;
    readonly idGen: IdGenerator;
    readonly nowMs: UnixMs;
  }): Promise<{
    readonly code: string;
    readonly expiresAtMs: UnixMs;
    readonly storeId: UuidV7;
    readonly storeName: string;
  }> {
    const rawCode = generatePairingCode();
    const codeHash = hashSecret(rawCode);
    const expiresAtMs = (BigInt(params.nowMs) + TEN_MINUTES_MS) as UnixMs;
    const pairingCodeId = params.idGen.nextId();

    return withPgTenantContext(this.pool, params.organizationId, async (tx) => {
      const storeRes = await tx
        .select()
        .from(cloudStores)
        .where(
          and(
            eq(cloudStores.organizationId, params.organizationId),
            eq(cloudStores.id, params.storeId),
          ),
        )
        .limit(1);

      if (storeRes.length === 0) {
        throw new DomainError('STORE_NOT_FOUND', 'Do‘kon topilmadi');
      }

      await tx.insert(cloudDevicePairingCodes).values({
        id: pairingCodeId,
        organizationId: params.organizationId,
        storeId: params.storeId,
        deviceName: params.deviceName.trim(),
        codeHash,
        attemptsLeft: 5,
        expiresAtMs: BigInt(expiresAtMs),
        usedAtMs: null,
        createdAtMs: params.nowMs,
        updatedAtMs: params.nowMs,
      });

      return {
        code: rawCode,
        expiresAtMs,
        storeId: params.storeId,
        storeName: storeRes[0].name,
      };
    });
  }

  /**
   * Pre-auth lookup using SECURITY DEFINER function `auth_lookup_pairing_code` (D1 requirement).
   * mezon_app role cannot directly query other tenants' pairing codes under fail-closed RLS.
   */
  async lookupPairingCode(code: string): Promise<PairingCodeLookup | null> {
    const codeHash = hashSecret(code.trim().toUpperCase());
    const res = await this.pool.query<{
      pairing_code_id: string;
      organization_id: string;
      store_id: string;
      device_name: string;
      attempts_left: number;
      expires_at_ms: string | number | bigint;
      used_at_ms: string | number | bigint | null;
    }>(
      `SELECT pairing_code_id, organization_id, store_id, device_name, attempts_left, expires_at_ms, used_at_ms
       FROM auth_lookup_pairing_code($1)
       LIMIT 1`,
      [codeHash],
    );

    if (res.rows.length === 0) {
      return null;
    }

    const row = res.rows[0];
    return {
      pairingCodeId: parseUuidV7(row.pairing_code_id),
      organizationId: parseUuidV7(row.organization_id),
      storeId: parseUuidV7(row.store_id),
      deviceName: row.device_name,
      attemptsLeft: Number(row.attempts_left ?? 0),
      expiresAtMs: BigInt(row.expires_at_ms),
      usedAtMs:
        row.used_at_ms !== null && row.used_at_ms !== undefined ? BigInt(row.used_at_ms) : null,
    };
  }

  /**
   * Pre-auth lookup using SECURITY DEFINER function `auth_lookup_device_owner`.
   * Enforces that a physical deviceId cannot be paired across different tenants.
   */
  async lookupDeviceOwner(deviceId: UuidV7): Promise<DeviceOwnerLookup | null> {
    const res = await this.pool.query<{
      organization_id: string;
      device_status: string;
    }>(
      `SELECT organization_id, device_status
       FROM auth_lookup_device_owner($1)
       LIMIT 1`,
      [deviceId],
    );

    if (res.rows.length === 0) {
      return null;
    }

    const row = res.rows[0];
    return {
      organizationId: parseUuidV7(row.organization_id),
      deviceStatus: row.device_status,
    };
  }

  /**
   * Pairs a physical device with tenant and store in a single atomic transaction.
   * Concurrency-guarded: exactly one caller marks `used_at_ms` (D1 requirement).
   */
  async pairDevice(params: {
    readonly pairingLookup: PairingCodeLookup;
    readonly deviceId: UuidV7;
    readonly platform: 'windows' | 'android' | 'linux';
    readonly appVersion: string;
    readonly idGen: IdGenerator;
    readonly nowMs: UnixMs;
  }): Promise<{
    readonly deviceToken: string;
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly storeName: string;
    readonly organizationName: string;
  }> {
    const { pairingLookup } = params;

    // Check if deviceId is already registered under another organization
    const existingOwner = await this.lookupDeviceOwner(params.deviceId);
    if (existingOwner && existingOwner.organizationId !== pairingLookup.organizationId) {
      throw new DomainError(
        'DEVICE_ALREADY_REGISTERED',
        'Ushbu qurilma allaqachon boshqa tashkilotga bog‘langan',
      );
    }

    return withPgTenantContext(this.pool, pairingLookup.organizationId, async (tx, client) => {
      // 1. Atomic concurrency guard on pairing code (D1)
      const updateRes = await client.query(
        `UPDATE cloud_device_pairing_codes
         SET used_at_ms = $1, updated_at_ms = $1
         WHERE id = $2 AND used_at_ms IS NULL
         RETURNING id`,
        [params.nowMs, pairingLookup.pairingCodeId],
      );

      if (updateRes.rows.length === 0) {
        throw new DomainError('PAIRING_ALREADY_USED', 'Juftlash kodi allaqachon ishlatilgan');
      }

      // 2. Fetch Store & Organization info
      const storeRes = await tx
        .select()
        .from(cloudStores)
        .where(
          and(
            eq(cloudStores.organizationId, pairingLookup.organizationId),
            eq(cloudStores.id, pairingLookup.storeId),
          ),
        )
        .limit(1);

      if (storeRes.length === 0) {
        throw new DomainError('STORE_NOT_FOUND', 'Do‘kon topilmadi');
      }

      const orgRes = await tx
        .select()
        .from(cloudOrganizations)
        .where(eq(cloudOrganizations.id, pairingLookup.organizationId))
        .limit(1);

      const organizationName = orgRes[0]?.name ?? 'Guzar Biznes';
      const storeName = storeRes[0].name;

      // 3. Upsert device entry
      const existingDevice = await tx
        .select()
        .from(cloudDevices)
        .where(
          and(
            eq(cloudDevices.organizationId, pairingLookup.organizationId),
            eq(cloudDevices.deviceId, params.deviceId),
          ),
        )
        .limit(1);

      if (existingDevice.length > 0) {
        await tx
          .update(cloudDevices)
          .set({
            storeId: pairingLookup.storeId,
            name: pairingLookup.deviceName,
            platform: params.platform,
            appVersion: params.appVersion,
            status: 'active',
            lastSeenAtMs: BigInt(params.nowMs),
            updatedAtMs: params.nowMs,
          })
          .where(
            and(
              eq(cloudDevices.organizationId, pairingLookup.organizationId),
              eq(cloudDevices.deviceId, params.deviceId),
            ),
          );

        // Revoke any previous active tokens for clean re-pairing
        await tx
          .update(cloudDeviceTokens)
          .set({
            revokedAtMs: BigInt(params.nowMs),
          })
          .where(
            and(
              eq(cloudDeviceTokens.organizationId, pairingLookup.organizationId),
              eq(cloudDeviceTokens.deviceId, params.deviceId),
              isNull(cloudDeviceTokens.revokedAtMs),
            ),
          );
      } else {
        await tx.insert(cloudDevices).values({
          id: params.idGen.nextId(),
          organizationId: pairingLookup.organizationId,
          storeId: pairingLookup.storeId,
          deviceId: params.deviceId,
          name: pairingLookup.deviceName,
          platform: params.platform,
          appVersion: params.appVersion,
          status: 'active',
          lastSeenAtMs: BigInt(params.nowMs),
          createdAtMs: params.nowMs,
          updatedAtMs: params.nowMs,
        });
      }

      // 4. Issue new device token (90-day lifespan)
      const rawSecret = randomBytes(32).toString('base64url');
      const deviceToken = `${pairingLookup.organizationId}.${params.deviceId}.${rawSecret}`;
      const tokenHash = hashSecret(rawSecret);
      const expiresAtMs = BigInt(params.nowMs) + NINETY_DAYS_MS;

      await tx.insert(cloudDeviceTokens).values({
        id: params.idGen.nextId(),
        organizationId: pairingLookup.organizationId,
        deviceId: params.deviceId,
        tokenHash,
        clientRequestId: null,
        expiresAtMs,
        revokedAtMs: null,
        graceUntilMs: null,
        replacedByTokenId: null,
        createdAtMs: params.nowMs,
        updatedAtMs: params.nowMs,
      });

      return {
        deviceToken,
        organizationId: pairingLookup.organizationId,
        storeId: pairingLookup.storeId,
        storeName,
        organizationName,
      };
    });
  }

  /**
   * Verifies an incoming device token under tenant RLS.
   * Handles D2 network grace period and detects token reuse (Security Wipe).
   */
  async verifyDeviceToken(
    deviceToken: string,
    nowMs: UnixMs,
  ): Promise<VerifiedDeviceContext | null> {
    const parts = deviceToken.split('.');
    if (parts.length !== 3) {
      return null;
    }
    const [orgIdStr, deviceIdStr, rawSecret] = parts;
    if (!orgIdStr || !deviceIdStr || !rawSecret) {
      return null;
    }

    let organizationId: UuidV7;
    let deviceId: UuidV7;
    try {
      organizationId = parseUuidV7(orgIdStr);
      deviceId = parseUuidV7(deviceIdStr);
    } catch {
      return null;
    }

    const tokenHash = hashSecret(rawSecret);

    const result = await withPgTenantContext(this.pool, organizationId, async (tx) => {
      const tokens = await tx
        .select()
        .from(cloudDeviceTokens)
        .where(
          and(
            eq(cloudDeviceTokens.organizationId, organizationId),
            eq(cloudDeviceTokens.deviceId, deviceId),
            eq(cloudDeviceTokens.tokenHash, tokenHash),
          ),
        )
        .limit(1);

      if (tokens.length === 0) {
        return null;
      }

      const tokenRecord = tokens[0];

      // Lookup device state
      const devices = await tx
        .select()
        .from(cloudDevices)
        .where(
          and(eq(cloudDevices.organizationId, organizationId), eq(cloudDevices.deviceId, deviceId)),
        )
        .limit(1);

      if (devices.length === 0) {
        return null;
      }

      const device = devices[0];
      if (device.status !== 'active') {
        throw new DomainError('DEVICE_REVOKED', 'Qurilma bekor qilingan yoki bloklangan');
      }

      // Check D2 Grace Period vs Token Reuse
      if (tokenRecord.revokedAtMs !== null) {
        const isWithinGrace =
          tokenRecord.graceUntilMs !== null && tokenRecord.graceUntilMs > BigInt(nowMs);

        if (!isWithinGrace) {
          // Token reuse detected outside grace window! Security wipe!
          // Must commit this transaction before throwing so the wipe persists!
          await tx
            .update(cloudDeviceTokens)
            .set({ revokedAtMs: BigInt(nowMs) })
            .where(
              and(
                eq(cloudDeviceTokens.organizationId, organizationId),
                eq(cloudDeviceTokens.deviceId, deviceId),
                isNull(cloudDeviceTokens.revokedAtMs),
              ),
            );

          await tx
            .update(cloudDevices)
            .set({ status: 'blocked', updatedAtMs: nowMs })
            .where(
              and(
                eq(cloudDevices.organizationId, organizationId),
                eq(cloudDevices.deviceId, deviceId),
              ),
            );

          return { reuseDetected: true as const };
        }
      }

      // Check token expiry
      if (tokenRecord.expiresAtMs < BigInt(nowMs)) {
        throw new DomainError('AUTH_UNAUTHORIZED', 'Qurilma tokenining muddati o‘tgan');
      }

      // Update last seen
      await tx
        .update(cloudDevices)
        .set({ lastSeenAtMs: BigInt(nowMs) })
        .where(
          and(eq(cloudDevices.organizationId, organizationId), eq(cloudDevices.deviceId, deviceId)),
        );

      return {
        organizationId,
        storeId: parseUuidV7(device.storeId),
        deviceId,
        deviceName: device.name,
        status: device.status as 'active' | 'blocked' | 'revoked',
      };
    });

    if (result && 'reuseDetected' in result && result.reuseDetected) {
      throw new DomainError(
        'DEVICE_TOKEN_REUSE',
        'Qurilma tokeni qayta ishlatildi (reuse detected)',
      );
    }

    return result;
  }

  /**
   * Rotates device token with network-drop tolerance (D2 idempotency & grace).
   */
  async rotateDeviceToken(params: {
    readonly currentToken: string;
    readonly clientRequestId: UuidV7;
    readonly idGen: IdGenerator;
    readonly nowMs: UnixMs;
  }): Promise<{
    readonly deviceToken: string;
    readonly expiresAtMs: number;
  }> {
    const verified = await this.verifyDeviceToken(params.currentToken, params.nowMs);
    if (!verified) {
      throw new DomainError('AUTH_UNAUTHORIZED', 'Yaroqsiz qurilma tokeni');
    }

    const { organizationId, deviceId } = verified;
    const parts = params.currentToken.split('.');
    const oldSecret = parts[2];
    const oldTokenHash = hashSecret(oldSecret);

    return withPgTenantContext(this.pool, organizationId, async (tx) => {
      // 1. Idempotency check: if this clientRequestId was already processed, return existing new token
      const existingByReq = await tx
        .select()
        .from(cloudDeviceTokens)
        .where(
          and(
            eq(cloudDeviceTokens.organizationId, organizationId),
            eq(cloudDeviceTokens.deviceId, deviceId),
            eq(cloudDeviceTokens.clientRequestId, params.clientRequestId),
          ),
        )
        .limit(1);

      if (existingByReq.length > 0) {
        const row = existingByReq[0];
        // Token was already generated for this request id; return token with same expiration
        return {
          deviceToken: `${organizationId}.${deviceId}.${row.tokenHash}`, // Note: in real flow secret was sent once
          expiresAtMs: Number(row.expiresAtMs),
        };
      }

      // 2. Issue new token (90 days)
      const newSecret = randomBytes(32).toString('base64url');
      const newToken = `${organizationId}.${deviceId}.${newSecret}`;
      const newTokenHash = hashSecret(newSecret);
      const newTokenId = params.idGen.nextId();
      const newExpiresAtMs = BigInt(params.nowMs) + NINETY_DAYS_MS;

      await tx.insert(cloudDeviceTokens).values({
        id: newTokenId,
        organizationId,
        deviceId,
        tokenHash: newTokenHash,
        clientRequestId: params.clientRequestId,
        expiresAtMs: newExpiresAtMs,
        revokedAtMs: null,
        graceUntilMs: null,
        replacedByTokenId: null,
        createdAtMs: params.nowMs,
        updatedAtMs: params.nowMs,
      });

      // 3. Mark old token with 10-minute grace period before full revocation (D2)
      const graceUntilMs = BigInt(params.nowMs) + TEN_MINUTES_MS;
      await tx
        .update(cloudDeviceTokens)
        .set({
          revokedAtMs: BigInt(params.nowMs),
          graceUntilMs,
          replacedByTokenId: newTokenId,
          updatedAtMs: params.nowMs,
        })
        .where(
          and(
            eq(cloudDeviceTokens.organizationId, organizationId),
            eq(cloudDeviceTokens.deviceId, deviceId),
            eq(cloudDeviceTokens.tokenHash, oldTokenHash),
          ),
        );

      return {
        deviceToken: newToken,
        expiresAtMs: Number(newExpiresAtMs),
      };
    });
  }

  /**
   * Revokes a device and all its active tokens (cabinet owner).
   */
  async revokeDevice(params: {
    readonly organizationId: UuidV7;
    readonly deviceDbId: UuidV7;
    readonly nowMs: UnixMs;
  }): Promise<void> {
    await withPgTenantContext(this.pool, params.organizationId, async (tx) => {
      const devices = await tx
        .select()
        .from(cloudDevices)
        .where(
          and(
            eq(cloudDevices.organizationId, params.organizationId),
            eq(cloudDevices.id, params.deviceDbId),
          ),
        )
        .limit(1);

      if (devices.length === 0) {
        throw new DomainError('DEVICE_NOT_FOUND', 'Qurilma topilmadi');
      }

      const device = devices[0];

      // Mark device revoked
      await tx
        .update(cloudDevices)
        .set({
          status: 'revoked',
          updatedAtMs: params.nowMs,
        })
        .where(
          and(
            eq(cloudDevices.organizationId, params.organizationId),
            eq(cloudDevices.id, params.deviceDbId),
          ),
        );

      // Revoke all tokens immediately
      await tx
        .update(cloudDeviceTokens)
        .set({
          revokedAtMs: BigInt(params.nowMs),
          graceUntilMs: null,
          updatedAtMs: params.nowMs,
        })
        .where(
          and(
            eq(cloudDeviceTokens.organizationId, params.organizationId),
            eq(cloudDeviceTokens.deviceId, device.deviceId),
            isNull(cloudDeviceTokens.revokedAtMs),
          ),
        );
    });
  }
}
