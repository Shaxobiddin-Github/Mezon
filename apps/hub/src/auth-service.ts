import { createHash } from 'node:crypto';
import type {
  AuthMeResponseDto,
  CreateUserRequestDto,
  DeleteUserResponseDto,
  HealthResponseDto,
  ListUsersResponseDto,
  LoginOptionsResponseDto,
  LoginRequestDto,
  LoginResponseDto,
  LogoutResponseDto,
  ResetUserPinRequestDto,
  SetupRequestDto,
  SetupResponseDto,
  UnlockUserResponseDto,
  UpdateUserRequestDto,
  UserResponseDto,
  UserSummaryDto,
} from '@mezon/contracts';
import type {
  AuthenticatedSessionSnapshot,
  LoginCredentialSnapshot,
  LoginSelector,
  SqliteHubAuthStore,
  StoredUserRecord,
} from '@mezon/db-local';
import {
  DomainError,
  type HubPermission,
  PIN_SECURITY_CONSTANTS,
  type PinHasher,
  type RandomSource,
  type UserRole,
  type UuidV7,
  roleHasPermission,
} from '@mezon/domain';

const SUPERVISOR_ROLES: readonly UserRole[] = ['owner', 'manager'];

export function hashBearerToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

function toUserSummaryDto(user: StoredUserRecord): UserSummaryDto {
  return {
    id: user.id,
    organizationId: user.organizationId,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    isActive: user.isActive,
  };
}

export function extractBearerToken(authorizationHeader: string | string[] | undefined): string {
  if (typeof authorizationHeader !== 'string') {
    throw new DomainError('AUTH_UNAUTHORIZED', 'Missing Authorization header');
  }
  const spaceIndex = authorizationHeader.indexOf(' ');
  if (spaceIndex <= 0) {
    throw new DomainError('AUTH_UNAUTHORIZED', 'Invalid Authorization header scheme');
  }
  const scheme = authorizationHeader.slice(0, spaceIndex);
  const token = authorizationHeader.slice(spaceIndex + 1).trim();
  if (scheme !== 'Bearer' || token.length === 0) {
    throw new DomainError('AUTH_UNAUTHORIZED', 'Authorization header must use Bearer token');
  }
  return token;
}

export class HubAuthService {
  private readonly store: SqliteHubAuthStore;
  private readonly pinHasher: PinHasher;
  private readonly random: RandomSource;
  private readonly dummyPinHash: string;

  private constructor(params: {
    readonly store: SqliteHubAuthStore;
    readonly pinHasher: PinHasher;
    readonly random: RandomSource;
    readonly dummyPinHash: string;
  }) {
    this.store = params.store;
    this.pinHasher = params.pinHasher;
    this.random = params.random;
    this.dummyPinHash = params.dummyPinHash;
  }

  static async create(params: {
    readonly store: SqliteHubAuthStore;
    readonly pinHasher: PinHasher;
    readonly random: RandomSource;
  }): Promise<HubAuthService> {
    const dummyPinHash = await params.pinHasher.hash('mezon-constant-time-dummy-pin-908172');
    return new HubAuthService({
      store: params.store,
      pinHasher: params.pinHasher,
      random: params.random,
      dummyPinHash,
    });
  }

  async getHealth(): Promise<HealthResponseDto> {
    const { needsSetup } = await this.store.getHealthStatus();
    return {
      status: 'ok',
      service: '@mezon/hub',
      needsSetup,
    };
  }

  async setup(input: SetupRequestDto): Promise<SetupResponseDto> {
    const { needsSetup } = await this.store.getHealthStatus();
    if (!needsSetup) {
      throw new DomainError(
        'SETUP_ALREADY_COMPLETED',
        'First-run setup has already been completed',
      );
    }

    const pinHash = await this.pinHasher.hash(input.owner.pin);
    const res = await this.store.completeSetup({
      fullName: input.owner.fullName,
      username: input.owner.username,
      pinHash,
    });

    return {
      organizationId: res.organizationId,
      storeId: res.storeId,
      deviceId: res.deviceId,
      owner: toUserSummaryDto(res.owner),
    };
  }

  async listLoginOptions(): Promise<LoginOptionsResponseDto> {
    const options = await this.store.listLoginOptions();
    return {
      options: options.map((o) => ({
        id: o.id,
        fullName: o.fullName,
        role: o.role,
      })),
    };
  }

  private async verifyPinLockFreePhase(input: LoginRequestDto): Promise<{
    readonly selector: LoginSelector;
    readonly snap: LoginCredentialSnapshot;
    readonly verifiedPinForUserId: UuidV7 | null;
    readonly verifiedPinHash: string | null;
  }> {
    const selector: LoginSelector =
      'username' in input
        ? { kind: 'username', username: input.username }
        : { kind: 'userId', userId: input.userId };

    // Phase 1 (read-only snapshot outside write lock)
    const snap = await this.store.prepareLoginSnapshot(selector);
    if (snap.kind === 'rate_limited') {
      throw new DomainError('AUTH_RATE_LIMITED', 'Too many failed login attempts', {
        retryAfterSeconds: snap.retryAfterSeconds ?? 1n,
      });
    }

    // Phase 2 (asynchronous constant-cost Argon2id outside SQLite transactions)
    const candidateHash = snap.pinHash ?? this.dummyPinHash;
    const pinMatches = await this.pinHasher.verify(candidateHash, input.pin);
    const verifiedPinForUserId =
      pinMatches && snap.user !== null && snap.user.isActive && snap.pinHash !== null
        ? snap.user.id
        : null;

    return {
      selector,
      snap,
      verifiedPinForUserId,
      verifiedPinHash: verifiedPinForUserId !== null ? snap.pinHash : null,
    };
  }

  async login(input: LoginRequestDto): Promise<LoginResponseDto> {
    const { selector, verifiedPinForUserId, verifiedPinHash } =
      await this.verifyPinLockFreePhase(input);

    const rawBytes = this.random.nextBytes(PIN_SECURITY_CONSTANTS.SESSION_TOKEN_BYTES);
    const rawToken = Buffer.from(rawBytes).toString('base64url');
    const tokenHash = hashBearerToken(rawToken);

    // Phase 3 (atomic UoW write that commits BOTH failed attempt counters AND valid sessions)
    const committed = await this.store.commitLoginOutcome({
      selector,
      verifiedPinForUserId,
      verifiedPinHash,
      tokenHashToMint: tokenHash,
    });

    // Phase 4 (return / throw only AFTER Phase 3 has committed)
    if (committed.kind === 'rate_limited') {
      throw new DomainError('AUTH_RATE_LIMITED', 'Too many failed login attempts', {
        retryAfterSeconds: committed.retryAfterSeconds,
      });
    }
    if (committed.kind === 'invalid_credentials') {
      throw new DomainError('AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
    }

    return {
      token: rawToken,
      tokenType: 'Bearer',
      expiresAtMs: committed.expiresAtMs.toString(),
      user: toUserSummaryDto(committed.user),
    };
  }

  /**
   * Verifies a supervisor (`owner` / `manager`) PIN using the same lock-free Argon2id,
   * TOCTOU guard, 5-attempt lockout, and progressive device backoff rules as `/auth/login`,
   * without minting a login session (`T1.3`).
   */
  async verifySupervisorPin(input: LoginRequestDto): Promise<StoredUserRecord> {
    const { selector, verifiedPinForUserId, verifiedPinHash } =
      await this.verifyPinLockFreePhase(input);

    const committed = await this.store.commitPinVerificationOutcome({
      selector,
      verifiedPinForUserId,
      verifiedPinHash,
      allowedRoles: SUPERVISOR_ROLES,
    });

    if (committed.kind === 'rate_limited') {
      throw new DomainError('AUTH_RATE_LIMITED', 'Too many failed PIN attempts', {
        retryAfterSeconds: committed.retryAfterSeconds,
      });
    }
    if (committed.kind === 'role_forbidden') {
      throw new DomainError('AUTH_FORBIDDEN', 'Only owner or manager may authorize overrides');
    }
    if (committed.kind === 'invalid_credentials') {
      throw new DomainError('AUTH_INVALID_CREDENTIALS', 'Invalid supervisor PIN');
    }

    return committed.user;
  }

  async authenticate(
    authorizationHeader: string | string[] | undefined,
  ): Promise<AuthenticatedSessionSnapshot> {
    const rawToken = extractBearerToken(authorizationHeader);
    const tokenHash = hashBearerToken(rawToken);
    const session = await this.store.authenticateSession(tokenHash);
    if (!session) {
      throw new DomainError('AUTH_UNAUTHORIZED', 'Session is invalid or expired');
    }
    return session;
  }

  assertPermission(session: AuthenticatedSessionSnapshot, permission: HubPermission): void {
    if (!roleHasPermission(session.user.role, permission)) {
      throw new DomainError('AUTH_FORBIDDEN', 'Role does not permit this operation');
    }
  }

  async logout(session: AuthenticatedSessionSnapshot): Promise<LogoutResponseDto> {
    await this.store.revokeSession(session.sessionId);
    return { revoked: true };
  }

  me(session: AuthenticatedSessionSnapshot): AuthMeResponseDto {
    return {
      user: toUserSummaryDto(session.user),
      session: {
        id: session.sessionId,
        deviceId: session.deviceId,
        expiresAtMs: session.expiresAtMs.toString(),
      },
    };
  }

  async listUsers(): Promise<ListUsersResponseDto> {
    const records = await this.store.listUsers();
    return {
      users: records.map(toUserSummaryDto),
    };
  }

  async createUser(input: CreateUserRequestDto): Promise<UserResponseDto> {
    const pinHash = await this.pinHasher.hash(input.pin);
    const created = await this.store.createUser({
      fullName: input.fullName,
      username: input.username,
      role: input.role,
      pinHash,
    });
    return { user: toUserSummaryDto(created) };
  }

  async updateUser(userId: UuidV7, input: UpdateUserRequestDto): Promise<UserResponseDto> {
    const updated = await this.store.updateUser({
      userId,
      fullName: input.fullName,
      role: input.role,
      isActive: input.isActive,
    });
    return { user: toUserSummaryDto(updated) };
  }

  async resetUserPin(
    userId: UuidV7,
    input: ResetUserPinRequestDto,
  ): Promise<{ readonly updated: true }> {
    const pinHash = await this.pinHasher.hash(input.pin);
    await this.store.resetUserPin({ userId, pinHash });
    return { updated: true };
  }

  async unlockUser(userId: UuidV7): Promise<UnlockUserResponseDto> {
    await this.store.unlockUser(userId);
    return {
      unlocked: true,
      userId,
    };
  }

  async deleteUser(userId: UuidV7): Promise<DeleteUserResponseDto> {
    await this.store.tombstoneUser(userId);
    return {
      deleted: true,
      userId,
    };
  }
}
