import {
  type Clock,
  DomainError,
  MonotonicUuidV7Generator,
  PIN_SECURITY_CONSTANTS,
  type RandomSource,
  type UnixMs,
  type UserRole,
  type UuidV7,
  computeDeviceCooldownDelayMs,
  computeRetryAfterSeconds,
  normalizeUsername,
  parseUuidV7,
  unixMsFromBigInt,
  validateFullName,
} from '@mezon/domain';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { LocalSqliteConnection } from './connection.js';
import {
  localDeviceAuthState,
  localHubConfig,
  localPinCredentials,
  localSchemaRegistry,
  localSessions,
  users,
} from './schema/index.js';
import {
  SqliteUnitOfWork,
  type SqliteUnitOfWorkSession,
  bootstrapSqliteHubUnitOfWork,
  createSqliteUnitOfWork,
  runConnectionReadOnly,
} from './uow.js';
import { insertAttr, tombstoneAttr, updateAttr } from './writers.js';

export interface HubConfigSnapshot {
  readonly organizationId: UuidV7;
  readonly storeId: UuidV7;
  readonly deviceId: UuidV7;
  readonly setupCompletedAtMs: UnixMs;
}

export interface StoredUserRecord {
  readonly id: UuidV7;
  readonly organizationId: UuidV7;
  readonly username: string;
  readonly fullName: string;
  readonly role: UserRole;
  readonly isActive: boolean;
}

export interface LoginOptionRecord {
  readonly id: UuidV7;
  readonly fullName: string;
  readonly role: UserRole;
}

export type LoginSelector =
  | { readonly kind: 'username'; readonly username: string }
  | { readonly kind: 'userId'; readonly userId: UuidV7 };

export interface LoginCredentialSnapshot {
  readonly kind: 'ready' | 'rate_limited';
  readonly retryAfterSeconds?: bigint;
  readonly hubConfig: HubConfigSnapshot | null;
  readonly user: StoredUserRecord | null;
  readonly pinHash: string | null;
}

export type CommitLoginOutcomeResult =
  | {
      readonly kind: 'authenticated';
      readonly user: StoredUserRecord;
      readonly sessionId: UuidV7;
      readonly deviceId: UuidV7;
      readonly expiresAtMs: UnixMs;
    }
  | {
      readonly kind: 'rate_limited';
      readonly retryAfterSeconds: bigint;
    }
  | {
      readonly kind: 'invalid_credentials';
    };

export interface AuthenticatedSessionSnapshot {
  readonly user: StoredUserRecord;
  readonly sessionId: UuidV7;
  readonly deviceId: UuidV7;
  readonly expiresAtMs: UnixMs;
}

export interface CreateSqliteHubAuthStoreOptions {
  readonly connection: LocalSqliteConnection;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly sessionTtlMs?: bigint;
  readonly lastSeenThrottleMs?: bigint;
  readonly userLockDurationMs?: bigint;
  readonly maxUserFailedAttempts?: number;
  readonly maxDeviceFailedAttempts?: number;
  readonly deviceFailureWindowMs?: bigint;
}

interface StoredPinCredentialRow {
  readonly id: UuidV7;
  readonly userId: UuidV7;
  readonly pinHash: string;
  readonly failedAttempts: number;
  readonly lockedUntilMs: UnixMs | null;
}

function toStoredUser(row: typeof users.$inferSelect): StoredUserRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    username: row.username,
    fullName: row.fullName,
    role: row.role as UserRole,
    isActive: Boolean(row.isActive),
  };
}

function isSqliteUniqueConstraintError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const code = (err as { readonly code?: unknown }).code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

/**
 * Coordinates all SQLite reads and writes for `@mezon/hub` authentication cleanly through
 * `@mezon/db-local`'s connection-level FIFO mutex, `SqliteUnitOfWork` (`execute` / `runReadOnly`),
 * and `bootstrapSqliteHubUnitOfWork` (`T0.6` T4).
 */
export class SqliteHubAuthStore {
  private readonly connection: LocalSqliteConnection;
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly sessionTtlMs: bigint;
  private readonly lastSeenThrottleMs: bigint;
  private readonly userLockDurationMs: bigint;
  private readonly maxUserFailedAttempts: number;
  private readonly maxDeviceFailedAttempts: number;
  private readonly deviceFailureWindowMs: bigint;

  private uow: SqliteUnitOfWork | null;
  private hubConfig: HubConfigSnapshot | null;

  private constructor(params: {
    readonly connection: LocalSqliteConnection;
    readonly clock: Clock;
    readonly random: RandomSource;
    readonly sessionTtlMs: bigint;
    readonly lastSeenThrottleMs: bigint;
    readonly userLockDurationMs: bigint;
    readonly maxUserFailedAttempts: number;
    readonly maxDeviceFailedAttempts: number;
    readonly deviceFailureWindowMs: bigint;
    readonly uow: SqliteUnitOfWork | null;
    readonly hubConfig: HubConfigSnapshot | null;
  }) {
    this.connection = params.connection;
    this.clock = params.clock;
    this.random = params.random;
    this.sessionTtlMs = params.sessionTtlMs;
    this.lastSeenThrottleMs = params.lastSeenThrottleMs;
    this.userLockDurationMs = params.userLockDurationMs;
    this.maxUserFailedAttempts = params.maxUserFailedAttempts;
    this.maxDeviceFailedAttempts = params.maxDeviceFailedAttempts;
    this.deviceFailureWindowMs = params.deviceFailureWindowMs;
    this.uow = params.uow;
    this.hubConfig = params.hubConfig;
  }

  static async create(options: CreateSqliteHubAuthStoreOptions): Promise<SqliteHubAuthStore> {
    const existingConfig = await runConnectionReadOnly(options.connection, () => {
      const rows = options.connection.db.select().from(localHubConfig).limit(1).all();
      const row = rows[0];
      if (!row) {
        return Promise.resolve<HubConfigSnapshot | null>(null);
      }
      return Promise.resolve<HubConfigSnapshot>({
        organizationId: row.organizationId,
        storeId: row.storeId,
        deviceId: row.deviceId,
        setupCompletedAtMs: row.setupCompletedAtMs,
      });
    });

    let uow: SqliteUnitOfWork | null = null;
    if (existingConfig !== null) {
      uow = await createSqliteUnitOfWork({
        connection: options.connection,
        organizationId: existingConfig.organizationId,
        deviceId: existingConfig.deviceId,
        registry: localSchemaRegistry,
        clock: options.clock,
        random: options.random,
      });
    }

    return new SqliteHubAuthStore({
      connection: options.connection,
      clock: options.clock,
      random: options.random,
      sessionTtlMs: options.sessionTtlMs ?? PIN_SECURITY_CONSTANTS.SESSION_TTL_MS,
      lastSeenThrottleMs:
        options.lastSeenThrottleMs ?? PIN_SECURITY_CONSTANTS.SESSION_LAST_SEEN_THROTTLE_MS,
      userLockDurationMs:
        options.userLockDurationMs ?? PIN_SECURITY_CONSTANTS.USER_LOCKOUT_DURATION_MS,
      maxUserFailedAttempts:
        options.maxUserFailedAttempts ?? PIN_SECURITY_CONSTANTS.MAX_USER_FAILED_ATTEMPTS,
      maxDeviceFailedAttempts:
        options.maxDeviceFailedAttempts ??
        PIN_SECURITY_CONSTANTS.MAX_DEVICE_FAILED_ATTEMPTS_IN_WINDOW,
      deviceFailureWindowMs:
        options.deviceFailureWindowMs ?? PIN_SECURITY_CONSTANTS.DEVICE_FAILURE_WINDOW_MS,
      uow,
      hubConfig: existingConfig,
    });
  }

  private async runSerializedRead<T>(fn: () => Promise<T>): Promise<T> {
    if (this.uow !== null) {
      return this.uow.runReadOnly(fn);
    }
    return runConnectionReadOnly(this.connection, fn);
  }

  private requireReady(): { readonly uow: SqliteUnitOfWork; readonly config: HubConfigSnapshot } {
    if (this.uow === null || this.hubConfig === null) {
      throw new DomainError('AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
    }
    return { uow: this.uow, config: this.hubConfig };
  }

  async getHealthStatus(): Promise<{ readonly needsSetup: boolean }> {
    return this.runSerializedRead(() => {
      const cfgCount = this.connection.db
        .select({ id: localHubConfig.id })
        .from(localHubConfig)
        .limit(1)
        .all().length;
      const userCount = this.connection.db
        .select({ id: users.id })
        .from(users)
        .limit(1)
        .all().length;
      return Promise.resolve({ needsSetup: cfgCount === 0 && userCount === 0 });
    });
  }

  async completeSetup(input: {
    readonly fullName: string;
    readonly username: string;
    readonly pinHash: string;
  }): Promise<{
    readonly organizationId: UuidV7;
    readonly storeId: UuidV7;
    readonly deviceId: UuidV7;
    readonly owner: StoredUserRecord;
  }> {
    const cleanName = validateFullName(input.fullName);
    const cleanUsername = normalizeUsername(input.username);

    const seedGen = new MonotonicUuidV7Generator({
      clock: this.clock,
      random: this.random,
    });
    const organizationId = seedGen.nextId();
    const storeId = seedGen.nextId();
    const deviceId = seedGen.nextId();

    const { uow, result } = await bootstrapSqliteHubUnitOfWork({
      connection: this.connection,
      organizationId,
      deviceId,
      registry: localSchemaRegistry,
      clock: this.clock,
      random: this.random,
      assertPrecondition: (db) => {
        const existingCfg = db
          .select({ id: localHubConfig.id })
          .from(localHubConfig)
          .limit(1)
          .all();
        const existingUser = db.select({ id: users.id }).from(users).limit(1).all();
        if (existingCfg.length > 0 || existingUser.length > 0) {
          throw new DomainError(
            'SETUP_ALREADY_COMPLETED',
            'First-run setup has already been completed',
          );
        }
      },
      fn: (session) => {
        const nowMs = session.nowUnixMs();
        session.db
          .insert(localHubConfig)
          .values({
            id: session.nextId(),
            organizationId,
            storeId,
            deviceId,
            singletonGuard: 1,
            setupCompletedAtMs: nowMs,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
          })
          .run();

        const ownerWrite = insertAttr(session, users, {
          organizationId,
          values: {
            username: cleanUsername,
            fullName: cleanName,
            role: 'owner',
            isActive: true,
          },
          eventType: 'user.created',
          schemaVersion: 1,
        });

        session.db
          .insert(localPinCredentials)
          .values({
            id: session.nextId(),
            organizationId,
            userId: ownerWrite.entityId,
            pinHash: input.pinHash,
            pinUpdatedAtMs: nowMs,
            failedAttempts: 0,
            lockedUntilMs: null,
            lastFailedAtMs: null,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
          })
          .run();

        return Promise.resolve({
          config: {
            organizationId,
            storeId,
            deviceId,
            setupCompletedAtMs: nowMs,
          } satisfies HubConfigSnapshot,
          owner: toStoredUser(ownerWrite.row),
        });
      },
    });

    this.uow = uow;
    this.hubConfig = result.config;

    return {
      organizationId,
      storeId,
      deviceId,
      owner: result.owner,
    };
  }

  async listLoginOptions(): Promise<readonly LoginOptionRecord[]> {
    return this.runSerializedRead(() => {
      if (this.hubConfig === null) {
        return Promise.resolve([]);
      }
      const rows = this.connection.db
        .select({
          id: users.id,
          fullName: users.fullName,
          role: users.role,
        })
        .from(users)
        .where(
          and(
            eq(users.organizationId, this.hubConfig.organizationId),
            isNull(users.deletedAtMs),
            eq(users.isActive, true),
          ),
        )
        .orderBy(asc(users.fullName), asc(users.id))
        .all();

      return Promise.resolve(
        rows.map((r) => ({
          id: r.id,
          fullName: r.fullName,
          role: r.role as UserRole,
        })),
      );
    });
  }

  async prepareLoginSnapshot(selector: LoginSelector): Promise<LoginCredentialSnapshot> {
    return this.runSerializedRead(() => {
      const config = this.hubConfig;
      if (config === null) {
        return Promise.resolve<LoginCredentialSnapshot>({
          kind: 'ready',
          hubConfig: null,
          user: null,
          pinHash: null,
        });
      }

      const nowMs = unixMsFromBigInt(this.clock.now());
      const deviceState = this.connection.db
        .select()
        .from(localDeviceAuthState)
        .where(eq(localDeviceAuthState.deviceId, config.deviceId))
        .limit(1)
        .all()[0];

      if (
        deviceState &&
        deviceState.nextAllowedAtMs !== null &&
        nowMs < deviceState.nextAllowedAtMs
      ) {
        return Promise.resolve<LoginCredentialSnapshot>({
          kind: 'rate_limited',
          retryAfterSeconds: computeRetryAfterSeconds(deviceState.nextAllowedAtMs - nowMs),
          hubConfig: config,
          user: null,
          pinHash: null,
        });
      }

      const userRow = this.findActiveUserRowSync(config.organizationId, selector);
      if (!userRow || !Boolean(userRow.isActive)) {
        return Promise.resolve<LoginCredentialSnapshot>({
          kind: 'ready',
          hubConfig: config,
          user: userRow ? toStoredUser(userRow) : null,
          pinHash: null,
        });
      }

      const cred = this.connection.db
        .select()
        .from(localPinCredentials)
        .where(eq(localPinCredentials.userId, userRow.id))
        .limit(1)
        .all()[0];

      if (cred && cred.lockedUntilMs !== null && nowMs < cred.lockedUntilMs) {
        return Promise.resolve<LoginCredentialSnapshot>({
          kind: 'rate_limited',
          retryAfterSeconds: computeRetryAfterSeconds(cred.lockedUntilMs - nowMs),
          hubConfig: config,
          user: toStoredUser(userRow),
          pinHash: null,
        });
      }

      return Promise.resolve<LoginCredentialSnapshot>({
        kind: 'ready',
        hubConfig: config,
        user: toStoredUser(userRow),
        pinHash: cred?.pinHash ?? null,
      });
    });
  }

  async commitLoginOutcome(input: {
    readonly selector: LoginSelector;
    readonly verifiedPinForUserId: UuidV7 | null;
    readonly verifiedPinHash: string | null;
    readonly tokenHashToMint: string;
  }): Promise<CommitLoginOutcomeResult> {
    if (this.uow === null || this.hubConfig === null) {
      return { kind: 'invalid_credentials' };
    }
    const { uow, config } = this.requireReady();

    return uow.execute((session) => {
      const commitNowMs = session.nowUnixMs();

      const deviceState = session.db
        .select()
        .from(localDeviceAuthState)
        .where(eq(localDeviceAuthState.deviceId, config.deviceId))
        .limit(1)
        .all()[0];

      if (
        deviceState &&
        deviceState.nextAllowedAtMs !== null &&
        commitNowMs < deviceState.nextAllowedAtMs
      ) {
        return Promise.resolve<CommitLoginOutcomeResult>({
          kind: 'rate_limited',
          retryAfterSeconds: computeRetryAfterSeconds(deviceState.nextAllowedAtMs - commitNowMs),
        });
      }

      const userRow = this.findActiveUserRowSync(config.organizationId, input.selector);
      const cred = userRow ? this.findPinCredSync(session, userRow.id) : null;

      if (
        userRow &&
        Boolean(userRow.isActive) &&
        cred &&
        cred.lockedUntilMs !== null &&
        commitNowMs < cred.lockedUntilMs
      ) {
        return Promise.resolve<CommitLoginOutcomeResult>({
          kind: 'rate_limited',
          retryAfterSeconds: computeRetryAfterSeconds(cred.lockedUntilMs - commitNowMs),
        });
      }

      // Guard against TOCTOU race where PIN was reset mid-flight during slow Argon2 verification (R1):
      // reject without creating a session and without penalizing failed_attempts counters.
      if (
        input.verifiedPinForUserId !== null &&
        userRow !== null &&
        userRow.id === input.verifiedPinForUserId &&
        cred !== null &&
        (input.verifiedPinHash === null || cred.pinHash !== input.verifiedPinHash)
      ) {
        return Promise.resolve<CommitLoginOutcomeResult>({
          kind: 'invalid_credentials',
        });
      }

      const pinMatchesExpectedUser =
        input.verifiedPinForUserId !== null &&
        input.verifiedPinHash !== null &&
        userRow !== null &&
        Boolean(userRow.isActive) &&
        cred !== null &&
        userRow.id === input.verifiedPinForUserId &&
        cred.pinHash === input.verifiedPinHash;

      if (pinMatchesExpectedUser && userRow && cred) {
        session.db
          .update(localPinCredentials)
          .set({
            failedAttempts: 0,
            lockedUntilMs: null,
            lastFailedAtMs: null,
            updatedAtMs: commitNowMs,
          })
          .where(eq(localPinCredentials.userId, userRow.id))
          .run();

        const sessionId = session.nextId();
        const expiresAtMs = unixMsFromBigInt(commitNowMs + this.sessionTtlMs);
        session.db
          .insert(localSessions)
          .values({
            id: sessionId,
            organizationId: config.organizationId,
            userId: userRow.id,
            deviceId: config.deviceId,
            tokenHash: input.tokenHashToMint,
            expiresAtMs,
            revokedAtMs: null,
            lastSeenAtMs: commitNowMs,
            createdAtMs: commitNowMs,
            updatedAtMs: commitNowMs,
          })
          .run();

        return Promise.resolve<CommitLoginOutcomeResult>({
          kind: 'authenticated',
          user: toStoredUser(userRow),
          sessionId,
          deviceId: config.deviceId,
          expiresAtMs,
        });
      }

      // Failed attempt: commit device backoff & user lockout inside this transaction (`T0.6` T1 & T2)
      const windowExpired =
        deviceState !== undefined &&
        commitNowMs - deviceState.windowStartedAtMs >= this.deviceFailureWindowMs;
      const nextDeviceWindowStart =
        deviceState === undefined || windowExpired ? commitNowMs : deviceState.windowStartedAtMs;
      const nextDeviceFails =
        deviceState === undefined || windowExpired ? 1 : deviceState.failedAttempts + 1;
      const cooldownMs = this.computeDeviceBackoffMs(nextDeviceFails);
      const nextAllowedAtMs = cooldownMs > 0n ? unixMsFromBigInt(commitNowMs + cooldownMs) : null;

      if (deviceState === undefined) {
        session.db
          .insert(localDeviceAuthState)
          .values({
            id: session.nextId(),
            organizationId: config.organizationId,
            deviceId: config.deviceId,
            windowStartedAtMs: nextDeviceWindowStart,
            failedAttempts: nextDeviceFails,
            nextAllowedAtMs,
            lastFailedAtMs: commitNowMs,
            createdAtMs: commitNowMs,
            updatedAtMs: commitNowMs,
          })
          .run();
      } else {
        session.db
          .update(localDeviceAuthState)
          .set({
            windowStartedAtMs: nextDeviceWindowStart,
            failedAttempts: nextDeviceFails,
            nextAllowedAtMs,
            lastFailedAtMs: commitNowMs,
            updatedAtMs: commitNowMs,
          })
          .where(eq(localDeviceAuthState.id, deviceState.id))
          .run();
      }

      if (userRow && Boolean(userRow.isActive) && cred) {
        const previousLockExpired =
          cred.lockedUntilMs !== null && commitNowMs >= cred.lockedUntilMs;
        const nextUserFails = previousLockExpired ? 1 : cred.failedAttempts + 1;
        const nextUserLockedUntil =
          nextUserFails >= this.maxUserFailedAttempts
            ? unixMsFromBigInt(commitNowMs + this.userLockDurationMs)
            : null;

        session.db
          .update(localPinCredentials)
          .set({
            failedAttempts: nextUserFails,
            lockedUntilMs: nextUserLockedUntil,
            lastFailedAtMs: commitNowMs,
            updatedAtMs: commitNowMs,
          })
          .where(eq(localPinCredentials.userId, userRow.id))
          .run();
      }

      return Promise.resolve<CommitLoginOutcomeResult>({
        kind: 'invalid_credentials',
      });
    });
  }

  async authenticateSession(tokenHash: string): Promise<AuthenticatedSessionSnapshot | null> {
    if (this.uow === null || this.hubConfig === null) {
      return null;
    }
    const { uow, config } = this.requireReady();

    const readResult = await uow.runReadOnly(() => {
      const nowMs = unixMsFromBigInt(this.clock.now());
      const rows = this.connection.db
        .select({
          session: localSessions,
          user: users,
        })
        .from(localSessions)
        .innerJoin(users, eq(localSessions.userId, users.id))
        .where(
          and(
            eq(localSessions.tokenHash, tokenHash),
            eq(localSessions.organizationId, config.organizationId),
            isNull(users.deletedAtMs),
          ),
        )
        .limit(1)
        .all();

      const row = rows[0];
      if (!row) {
        return Promise.resolve(null);
      }
      if (row.session.revokedAtMs !== null || nowMs >= row.session.expiresAtMs) {
        return Promise.resolve(null);
      }
      if (!Boolean(row.user.isActive)) {
        return Promise.resolve(null);
      }

      const needsLastSeenTouch = nowMs - row.session.lastSeenAtMs >= this.lastSeenThrottleMs;
      return Promise.resolve({
        snapshot: {
          user: toStoredUser(row.user),
          sessionId: row.session.id,
          deviceId: row.session.deviceId,
          expiresAtMs: row.session.expiresAtMs,
        } satisfies AuthenticatedSessionSnapshot,
        needsLastSeenTouch,
      });
    });

    if (!readResult) {
      return null;
    }

    if (readResult.needsLastSeenTouch) {
      await uow.execute((session) => {
        const touchNowMs = session.nowUnixMs();
        session.db
          .update(localSessions)
          .set({
            lastSeenAtMs: touchNowMs,
            updatedAtMs: touchNowMs,
          })
          .where(
            and(
              eq(localSessions.id, readResult.snapshot.sessionId),
              isNull(localSessions.revokedAtMs),
            ),
          )
          .run();
        return Promise.resolve();
      });
    }

    return readResult.snapshot;
  }

  async revokeSession(sessionId: UuidV7): Promise<void> {
    if (this.uow === null) {
      throw new DomainError('AUTH_UNAUTHORIZED', 'Not authenticated');
    }
    const { uow } = this.requireReady();
    await uow.execute((session) => {
      const nowMs = session.nowUnixMs();
      session.db
        .update(localSessions)
        .set({
          revokedAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .where(and(eq(localSessions.id, parseUuidV7(sessionId)), isNull(localSessions.revokedAtMs)))
        .run();
      return Promise.resolve();
    });
  }

  async listUsers(): Promise<readonly StoredUserRecord[]> {
    const { uow, config } = this.requireReady();
    return uow.runReadOnly(() => {
      const rows = this.connection.db
        .select()
        .from(users)
        .where(and(eq(users.organizationId, config.organizationId), isNull(users.deletedAtMs)))
        .orderBy(asc(users.createdAtMs), asc(users.id))
        .all();
      return Promise.resolve(rows.map(toStoredUser));
    });
  }

  async createUser(input: {
    readonly fullName: string;
    readonly username: string;
    readonly role: UserRole;
    readonly pinHash: string;
  }): Promise<StoredUserRecord> {
    const { uow, config } = this.requireReady();
    const cleanName = validateFullName(input.fullName);
    const cleanUsername = normalizeUsername(input.username);

    return uow.execute((session) => {
      const existing = this.findActiveUserRowSync(config.organizationId, {
        kind: 'username',
        username: cleanUsername,
      });
      if (existing !== null) {
        throw new DomainError(
          'USERNAME_ALREADY_EXISTS',
          `Username "${cleanUsername}" already exists`,
        );
      }

      try {
        const writeRes = insertAttr(session, users, {
          organizationId: config.organizationId,
          values: {
            username: cleanUsername,
            fullName: cleanName,
            role: input.role,
            isActive: true,
          },
          eventType: 'user.created',
          schemaVersion: 1,
        });

        const nowMs = session.nowUnixMs();
        session.db
          .insert(localPinCredentials)
          .values({
            id: session.nextId(),
            organizationId: config.organizationId,
            userId: writeRes.entityId,
            pinHash: input.pinHash,
            pinUpdatedAtMs: nowMs,
            failedAttempts: 0,
            lockedUntilMs: null,
            lastFailedAtMs: null,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
          })
          .run();

        return Promise.resolve(toStoredUser(writeRes.row));
      } catch (err) {
        if (isSqliteUniqueConstraintError(err)) {
          throw new DomainError(
            'USERNAME_ALREADY_EXISTS',
            `Username "${cleanUsername}" already exists`,
          );
        }
        throw err;
      }
    });
  }

  async updateUser(input: {
    readonly userId: UuidV7;
    readonly fullName?: string;
    readonly role?: UserRole;
    readonly isActive?: boolean;
  }): Promise<StoredUserRecord> {
    const { uow, config } = this.requireReady();
    const validId = parseUuidV7(input.userId);

    return uow.execute((session) => {
      const existing = this.findActiveUserRowSync(config.organizationId, {
        kind: 'userId',
        userId: validId,
      });
      if (!existing) {
        throw new DomainError('USER_NOT_FOUND', `User "${validId}" was not found`);
      }

      const nextFullName =
        input.fullName !== undefined ? validateFullName(input.fullName) : existing.fullName;
      const nextRole = input.role ?? (existing.role as UserRole);
      const nextIsActive = input.isActive ?? Boolean(existing.isActive);

      const wasActiveOwner = existing.role === 'owner' && Boolean(existing.isActive);
      const remainsActiveOwner = nextRole === 'owner' && nextIsActive;
      if (wasActiveOwner && !remainsActiveOwner) {
        this.assertAnotherActiveOwnerExistsSync(session, config.organizationId, existing.id);
      }

      const updRes = updateAttr(session, users, {
        id: existing.id,
        organizationId: config.organizationId,
        values: {
          ...(input.fullName !== undefined ? { fullName: nextFullName } : {}),
          ...(input.role !== undefined ? { role: nextRole } : {}),
          ...(input.isActive !== undefined ? { isActive: nextIsActive } : {}),
        },
        eventType: 'user.updated',
        schemaVersion: 1,
      });

      if (!nextIsActive || nextRole !== existing.role) {
        const nowMs = session.nowUnixMs();
        session.db
          .update(localSessions)
          .set({
            revokedAtMs: nowMs,
            updatedAtMs: nowMs,
          })
          .where(and(eq(localSessions.userId, existing.id), isNull(localSessions.revokedAtMs)))
          .run();
      }

      return Promise.resolve(toStoredUser(updRes.row));
    });
  }

  async resetUserPin(input: { readonly userId: UuidV7; readonly pinHash: string }): Promise<void> {
    const { uow, config } = this.requireReady();
    const validId = parseUuidV7(input.userId);

    await uow.execute((session) => {
      const existing = this.findActiveUserRowSync(config.organizationId, {
        kind: 'userId',
        userId: validId,
      });
      if (!existing) {
        throw new DomainError('USER_NOT_FOUND', `User "${validId}" was not found`);
      }

      const nowMs = session.nowUnixMs();
      session.db
        .update(localPinCredentials)
        .set({
          pinHash: input.pinHash,
          pinUpdatedAtMs: nowMs,
          failedAttempts: 0,
          lockedUntilMs: null,
          lastFailedAtMs: null,
          updatedAtMs: nowMs,
        })
        .where(eq(localPinCredentials.userId, existing.id))
        .run();

      session.db
        .update(localSessions)
        .set({
          revokedAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .where(and(eq(localSessions.userId, existing.id), isNull(localSessions.revokedAtMs)))
        .run();

      return Promise.resolve();
    });
  }

  async unlockUser(userId: UuidV7): Promise<void> {
    const { uow, config } = this.requireReady();
    const validId = parseUuidV7(userId);

    await uow.execute((session) => {
      const existing = this.findActiveUserRowSync(config.organizationId, {
        kind: 'userId',
        userId: validId,
      });
      if (!existing) {
        throw new DomainError('USER_NOT_FOUND', `User "${validId}" was not found`);
      }

      const nowMs = session.nowUnixMs();
      session.db
        .update(localPinCredentials)
        .set({
          failedAttempts: 0,
          lockedUntilMs: null,
          lastFailedAtMs: null,
          updatedAtMs: nowMs,
        })
        .where(eq(localPinCredentials.userId, existing.id))
        .run();

      return Promise.resolve();
    });
  }

  async tombstoneUser(userId: UuidV7): Promise<void> {
    const { uow, config } = this.requireReady();
    const validId = parseUuidV7(userId);

    await uow.execute((session) => {
      const existing = this.findActiveUserRowSync(config.organizationId, {
        kind: 'userId',
        userId: validId,
      });
      if (!existing) {
        throw new DomainError('USER_NOT_FOUND', `User "${validId}" was not found`);
      }

      if (existing.role === 'owner' && Boolean(existing.isActive)) {
        this.assertAnotherActiveOwnerExistsSync(session, config.organizationId, existing.id);
      }

      tombstoneAttr(session, users, {
        id: existing.id,
        organizationId: config.organizationId,
        eventType: 'user.deleted',
        schemaVersion: 1,
      });

      const nowMs = session.nowUnixMs();
      session.db
        .update(localSessions)
        .set({
          revokedAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .where(and(eq(localSessions.userId, existing.id), isNull(localSessions.revokedAtMs)))
        .run();

      return Promise.resolve();
    });
  }

  private findActiveUserRowSync(
    organizationId: UuidV7,
    selector: LoginSelector,
  ): typeof users.$inferSelect | null {
    const condition =
      selector.kind === 'username'
        ? and(
            eq(users.organizationId, organizationId),
            eq(users.username, normalizeUsername(selector.username)),
            isNull(users.deletedAtMs),
          )
        : and(
            eq(users.organizationId, organizationId),
            eq(users.id, parseUuidV7(selector.userId)),
            isNull(users.deletedAtMs),
          );

    return this.connection.db.select().from(users).where(condition).limit(1).all()[0] ?? null;
  }

  private findPinCredSync(
    session: SqliteUnitOfWorkSession,
    userId: UuidV7,
  ): StoredPinCredentialRow | null {
    const row = session.db
      .select()
      .from(localPinCredentials)
      .where(eq(localPinCredentials.userId, userId))
      .limit(1)
      .all()[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      userId: row.userId,
      pinHash: row.pinHash,
      failedAttempts: row.failedAttempts,
      lockedUntilMs: row.lockedUntilMs,
    };
  }

  private computeDeviceBackoffMs(failedAttemptsInWindow: number): bigint {
    if (failedAttemptsInWindow < this.maxDeviceFailedAttempts) {
      return 0n;
    }
    if (
      this.maxDeviceFailedAttempts === PIN_SECURITY_CONSTANTS.MAX_DEVICE_FAILED_ATTEMPTS_IN_WINDOW
    ) {
      return computeDeviceCooldownDelayMs(failedAttemptsInWindow);
    }
    const step = failedAttemptsInWindow - this.maxDeviceFailedAttempts;
    if (step >= 5) {
      return PIN_SECURITY_CONSTANTS.DEVICE_BACKOFF_MAX_MS;
    }
    const doubled = PIN_SECURITY_CONSTANTS.DEVICE_BACKOFF_BASE_MS << BigInt(step);
    return doubled > PIN_SECURITY_CONSTANTS.DEVICE_BACKOFF_MAX_MS
      ? PIN_SECURITY_CONSTANTS.DEVICE_BACKOFF_MAX_MS
      : doubled;
  }

  private assertAnotherActiveOwnerExistsSync(
    session: SqliteUnitOfWorkSession,
    organizationId: UuidV7,
    excludeUserId: UuidV7,
  ): void {
    const otherOwners = session.db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.organizationId, organizationId),
          eq(users.role, 'owner'),
          eq(users.isActive, true),
          isNull(users.deletedAtMs),
          ne(users.id, excludeUserId),
        ),
      )
      .limit(1)
      .all();

    if (otherOwners.length === 0) {
      throw new DomainError(
        'LAST_OWNER_PROTECTED',
        'Cannot disable, demote, or delete the last active owner',
      );
    }
  }
}

export async function createSqliteHubAuthStore(
  options: CreateSqliteHubAuthStoreOptions,
): Promise<SqliteHubAuthStore> {
  return SqliteHubAuthStore.create(options);
}
