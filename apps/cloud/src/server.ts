import { createHash, randomBytes } from 'node:crypto';
import {
  type CloudCreatePairingCodeRequestDto,
  CloudCreatePairingCodeRequestSchema,
  type CloudCreatePairingCodeResponseDto,
  type CloudCreateStoreRequestDto,
  CloudCreateStoreRequestSchema,
  type CloudLoginRequestDto,
  CloudLoginRequestSchema,
  type CloudLoginResponseDto,
  type CloudLogoutRequestDto,
  CloudLogoutRequestSchema,
  type CloudPairDeviceRequestDto,
  CloudPairDeviceRequestSchema,
  type CloudPairDeviceResponseDto,
  type CloudRefreshRequestDto,
  CloudRefreshRequestSchema,
  type CloudRotateDeviceTokenRequestDto,
  CloudRotateDeviceTokenRequestSchema,
  type CloudRotateDeviceTokenResponseDto,
  type CloudStoreDto,
  type CloudUserDto,
  SyncPullQuerySchema,
  parseAndValidateSyncCursors,
  type SyncPullResponseDto,
} from '@mezon/contracts';
import {
  AdminReadStore,
  CloudTelegramStore,
  CloudAuthStore,
  CloudDeviceStore,
  CloudSyncPushStore,
  CloudSyncPullStore,
  ForeignStoreError,
  CloudTenantStore,
  type CloudPgConnection,
  type VerifiedDeviceContext,
  assertNonSuperuserNonBypassRls,
} from '@mezon/db-cloud';
import { registerAdminRoutes } from './admin-routes.js';
import { isTelegramEnabled } from './config.js';
import { TelegramBotService } from './telegram/bot-service.js';
import { TelegramScheduler } from './telegram/scheduler.js';
import { registerTelegramRoutes } from './telegram-routes.js';
import {
  MIN_CLIENT_VERSION,
  SyncPushRequestSchema,
  type SyncPushRequestDto,
  type SyncPushResponseDto,
} from '@mezon/sync';
import {
  DomainError,
  type IdGenerator,
  MonotonicUuidV7Generator,
  type UnixMs,
  type UuidV7,
  parseUuidV7,
  unixMsFromBigInt,
} from '@mezon/domain';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import * as argon2 from '@node-rs/argon2';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyError,
} from 'fastify';
import { HttpTelegramClient, type TelegramClient } from '@mezon/drivers';
import type { CloudConfig } from './config.js';
import { type CloudJwtPayload, CloudJwtService } from './jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: CloudJwtPayload;
    device?: VerifiedDeviceContext;
  }
}

export interface BuildServerOptions {
  readonly config: CloudConfig;
  readonly conn: CloudPgConnection<Record<string, unknown>>;
  readonly jwtService?: CloudJwtService;
  readonly authStore?: CloudAuthStore;
  readonly tenantStore?: CloudTenantStore;
  readonly deviceStore?: CloudDeviceStore;
  readonly syncPushStore?: CloudSyncPushStore;
  readonly adminStore?: AdminReadStore;
  /** T2.8: injected in tests (FakeTelegramClient); production builds HttpTelegramClient. */
  readonly telegramClient?: TelegramClient;
  readonly syncPullStore?: CloudSyncPullStore;
  readonly idGen?: { nextId(): UuidV7 };
  readonly clock?: { nowMs(): UnixMs };
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Server errors are logged in full but never sent to the client: Fastify's default handler put the
 * raw message (SQL column names, PG error codes) into the 500 body.
 */
export function cloudErrorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
  if (statusCode >= 500) {
    req.log.error({ err }, 'Unhandled server error');
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
  return reply.code(statusCode).send({ error: err.name, code: err.code, message: err.message });
}

declare module 'fastify' {
  interface FastifyInstance {
    /** T2.8: null when the Telegram bot is not configured; started by `startCloudServer`. */
    telegramScheduler: TelegramScheduler | null;
  }
}

export async function buildCloudServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { config, conn } = options;

  // S1 requirement: Server startup self-check. Ensures runtime pool connects as non-superuser, non-bypassrls role (mezon_app)
  await assertNonSuperuserNonBypassRls(conn.pool);

  const jwtService = options.jwtService ?? new CloudJwtService(config.jwtSecret);
  const authStore = options.authStore ?? new CloudAuthStore(conn.pool);
  const tenantStore = options.tenantStore ?? new CloudTenantStore(conn.pool);
  const deviceStore = options.deviceStore ?? new CloudDeviceStore(conn.pool);
  const syncPushStore = options.syncPushStore ?? new CloudSyncPushStore(conn.pool);
  const adminStore = options.adminStore ?? new AdminReadStore({ pool: conn.pool });
  const syncPullStore = options.syncPullStore ?? new CloudSyncPullStore(conn.pool);
  const defaultIdGen: IdGenerator = new MonotonicUuidV7Generator({
    clock: { now: () => unixMsFromBigInt(BigInt(Date.now())) },
    random: { nextBytes: (n: number) => randomBytes(n) },
  });
  const idGen = options.idGen ?? defaultIdGen;
  const clock = options.clock ?? { nowMs: () => unixMsFromBigInt(BigInt(Date.now())) };

  const app = Fastify({
    logger: {
      level: config.nodeEnv === 'test' ? 'silent' : 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'body.password',
          'body.refreshToken',
          'password',
          'refreshToken',
          'token',
          'secret',
          'phone',
          'body.phone',
        ],
        censor: '[REDACTED]',
      },
    },
  });

  app.setErrorHandler(cloudErrorHandler);

  // CORS
  await app.register(cors, {
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
    credentials: true,
  });

  // Rate Limiting (C5)
  await app.register(rateLimit, {
    max: 1000,
    timeWindow: '1 minute',
  });

  // Auth Hook
  app.decorateRequest('user', undefined);
  app.addHook('preHandler', async (req: FastifyRequest) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      try {
        const payload = await jwtService.verifyAccessToken(token);
        req.user = payload;
      } catch {
        // Leave req.user undefined; individual routes decide if auth is mandatory
      }
    }
  });

  function requireAuth(req: FastifyRequest, reply: FastifyReply): CloudJwtPayload {
    if (!req.user) {
      void reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required' });
      throw new Error('AUTH_REQUIRED');
    }
    return req.user;
  }

  // Health checks
  app.get('/health/live', () => ({ status: 'ok' }));

  app.get('/health/ready', async (_req, reply) => {
    try {
      await conn.pool.query('SELECT 1');
      return { status: 'ok', database: 'connected' };
    } catch (err) {
      void reply.code(503).send({ status: 'unhealthy', error: (err as Error).message });
    }
  });

  // POST /api/v1/auth/login (C1 Pre-auth & Lockout)
  app.post<{ Body: CloudLoginRequestDto }>(
    '/api/v1/auth/login',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
        },
      },
    },
    async (req, reply) => {
      const parseResult = CloudLoginRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          details: parseResult.error.flatten(),
        });
      }

      const { login, password } = parseResult.data;
      const nowMs = clock.nowMs();

      // Pre-auth lookup via SECURITY DEFINER function auth_lookup_login (C1)
      const lookup = await authStore.lookupLogin(login);
      if (!lookup) {
        // Prevent timing enumeration: run dummy hash verify
        await argon2
          .verify(
            '$argon2id$v=19$m=65536,t=3,p=4$dummyhashdummyhashdummyhash$dummyhashdummyhashdummyhash',
            password,
          )
          .catch(() => false);
        return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid credentials' });
      }

      if (lookup.userStatus !== 'active') {
        return reply.code(403).send({ error: 'Forbidden', message: 'User account is suspended' });
      }

      // Cloud accounts are owners and managers only (T2.1 C3): a cashier row never gets a cloud
      // token (ishchi2 review K3).
      if (lookup.userRole !== 'owner' && lookup.userRole !== 'manager') {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Only owners and managers have cloud accounts',
        });
      }

      // Check progressive lockout
      if (lookup.lockedUntilMs !== null && lookup.lockedUntilMs > BigInt(nowMs)) {
        return reply.code(429).send({
          error: 'Too Many Requests',
          message: 'Account temporarily locked due to failed attempts. Try again later.',
        });
      }

      const isValid = await argon2.verify(lookup.passwordHash, password);
      if (!isValid) {
        const attempts = lookup.failedLoginAttempts + 1;
        const lockedUntilMs =
          attempts >= 5 ? unixMsFromBigInt(BigInt(nowMs) + BigInt(FIVE_MINUTES_MS)) : null;

        await authStore.recordLoginFailure({
          organizationId: lookup.organizationId,
          userId: lookup.userId,
          attempts,
          lockedUntilMs,
          nowMs,
        });

        if (attempts >= 5) {
          return reply.code(429).send({
            error: 'Too Many Requests',
            message: 'Account locked for 5 minutes due to 5 failed attempts.',
          });
        }

        return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid credentials' });
      }

      // Successful login -> reset failure counter
      if (lookup.failedLoginAttempts > 0 || lookup.lockedUntilMs !== null) {
        await authStore.resetLoginFailure({
          organizationId: lookup.organizationId,
          userId: lookup.userId,
          nowMs,
        });
      }

      // Issue access token (15m)
      const accessToken = await jwtService.signAccessToken({
        sub: lookup.userId,
        org: lookup.organizationId,
        role: lookup.userRole,
        name: lookup.userName,
      });

      // Issue tenant-prefixed refresh token (C2): <organizationId>.<random32bytes>
      const rawSecret = randomBytes(32).toString('base64url');
      const refreshToken = `${lookup.organizationId}.${rawSecret}`;
      const tokenHash = createHash('sha256').update(rawSecret).digest('hex');
      const tokenId = idGen.nextId();
      const expiresAtMs = unixMsFromBigInt(BigInt(nowMs) + BigInt(THIRTY_DAYS_MS));

      await authStore.saveRefreshToken({
        organizationId: lookup.organizationId,
        tokenId,
        userId: lookup.userId,
        tokenHash,
        expiresAtMs,
        nowMs,
      });

      const response: CloudLoginResponseDto = {
        accessToken,
        refreshToken,
        user: {
          id: lookup.userId,
          organizationId: lookup.organizationId,
          username: lookup.userName,
          role: lookup.userRole,
        },
      };

      return reply.code(200).send(response);
    },
  );

  // POST /api/v1/auth/refresh (C2 Tenant-Prefixed Token Rotation & Reuse Detection)
  app.post<{ Body: CloudRefreshRequestDto }>('/api/v1/auth/refresh', async (req, reply) => {
    const parseResult = CloudRefreshRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        details: parseResult.error.flatten(),
      });
    }

    const { refreshToken } = parseResult.data;
    const dotIndex = refreshToken.indexOf('.');
    if (dotIndex === -1) {
      return reply
        .code(401)
        .send({ error: 'Unauthorized', message: 'Invalid refresh token format' });
    }

    const orgIdStr = refreshToken.slice(0, dotIndex);
    const secret = refreshToken.slice(dotIndex + 1);

    let orgId: UuidV7;
    try {
      orgId = parseUuidV7(orgIdStr);
    } catch {
      return reply
        .code(401)
        .send({ error: 'Unauthorized', message: 'Invalid refresh token prefix' });
    }

    const oldHash = createHash('sha256').update(secret).digest('hex');
    const nowMs = clock.nowMs();
    const nextTokenId = idGen.nextId();
    const nextSecret = randomBytes(32).toString('base64url');
    const nextHash = createHash('sha256').update(nextSecret).digest('hex');
    const newExpiresAtMs = unixMsFromBigInt(BigInt(nowMs) + BigInt(THIRTY_DAYS_MS));

    try {
      const rotated = await authStore.rotateRefreshToken({
        organizationId: orgId,
        oldTokenHash: oldHash,
        newTokenId: nextTokenId,
        newTokenHash: nextHash,
        newExpiresAtMs,
        nowMs,
        allowedRoles: ['owner', 'manager'],
      });

      // S1: claims are re-read from the user row on every refresh.
      const newAccessToken = await jwtService.signAccessToken({
        sub: rotated.userId,
        org: orgId,
        role: rotated.role,
        name: rotated.userName,
      });

      const newRefreshToken = `${orgId}.${nextSecret}`;

      return reply.code(200).send({
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      });
    } catch (err) {
      if (err instanceof DomainError && err.code === 'AUTH_UNAUTHORIZED') {
        return reply.code(401).send({ error: 'Unauthorized', message: err.message });
      }
      if (err instanceof DomainError && err.code === 'AUTH_FORBIDDEN') {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Only owners and managers have cloud accounts',
        });
      }
      throw err;
    }
  });

  // POST /api/v1/auth/logout
  app.post<{ Body: CloudLogoutRequestDto }>('/api/v1/auth/logout', async (req, reply) => {
    const parseResult = CloudLogoutRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply
        .code(400)
        .send({ error: 'Validation Error', details: parseResult.error.flatten() });
    }

    const { refreshToken } = parseResult.data;
    const dotIndex = refreshToken.indexOf('.');
    if (dotIndex !== -1) {
      const orgIdStr = refreshToken.slice(0, dotIndex);
      const secret = refreshToken.slice(dotIndex + 1);
      try {
        const orgId = parseUuidV7(orgIdStr);
        const hash = createHash('sha256').update(secret).digest('hex');
        await authStore.revokeRefreshToken({
          organizationId: orgId,
          tokenHash: hash,
          nowMs: clock.nowMs(),
        });
      } catch {
        // Ignore invalid logout tokens gracefully
      }
    }

    return reply.code(200).send({ success: true });
  });

  // GET /api/v1/me
  app.get('/api/v1/me', async (req, reply) => {
    let auth: CloudJwtPayload;
    try {
      auth = requireAuth(req, reply);
    } catch {
      return;
    }

    if (auth.role !== 'owner' && auth.role !== 'manager') {
      return reply.code(403).send({ error: 'Forbidden', message: 'Not a cloud account' });
    }
    const user: CloudUserDto = {
      id: auth.sub,
      organizationId: auth.org,
      username: auth.name,
      role: auth.role,
    };

    return reply.code(200).send({ user });
  });

  // GET /api/v1/stores (Tenant context isolated)
  app.get('/api/v1/stores', async (req, reply) => {
    let auth: CloudJwtPayload;
    try {
      auth = requireAuth(req, reply);
    } catch {
      return;
    }

    const stores = await tenantStore.listStores(auth.org);
    const dtos: CloudStoreDto[] = stores.map((s) => ({
      id: s.id,
      organizationId: s.organizationId,
      name: s.name,
      code: s.code,
      isActive: s.isActive,
      createdAtMs: Number(s.createdAtMs),
      updatedAtMs: Number(s.updatedAtMs),
    }));

    return reply.code(200).send({ stores: dtos });
  });

  // POST /api/v1/stores (Create store under tenant context)
  app.post<{ Body: CloudCreateStoreRequestDto }>('/api/v1/stores', async (req, reply) => {
    let auth: CloudJwtPayload;
    try {
      auth = requireAuth(req, reply);
    } catch {
      return;
    }

    if (auth.role !== 'owner') {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Only tenant owners may create stores',
      });
    }

    const parseResult = CloudCreateStoreRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        details: parseResult.error.flatten(),
      });
    }

    const { name, code } = parseResult.data;
    const storeId = idGen.nextId();
    const nowMs = clock.nowMs();

    const created = await tenantStore.createStore({
      storeId,
      organizationId: auth.org,
      name,
      code,
      nowMs,
    });

    const dto: CloudStoreDto = {
      id: created.id,
      organizationId: created.organizationId,
      name: created.name,
      code: created.code,
      isActive: created.isActive,
      createdAtMs: Number(created.createdAtMs),
      updatedAtMs: Number(created.updatedAtMs),
    };

    return reply.code(201).send({ store: dto });
  });

  async function requireDeviceAuth(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ readonly device: VerifiedDeviceContext; readonly token: string }> {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      void reply.code(401).send({ error: 'Unauthorized', message: 'Device token required' });
      throw new Error('DEVICE_AUTH_REQUIRED');
    }

    const token = authHeader.slice(7).trim();
    try {
      const verified = await deviceStore.verifyDeviceToken(token, clock.nowMs());
      if (!verified) {
        void reply.code(401).send({ error: 'Unauthorized', message: 'Invalid device token' });
        throw new Error('DEVICE_AUTH_REQUIRED');
      }
      return { device: verified, token };
    } catch (err) {
      if (err instanceof DomainError) {
        if (err.code === 'DEVICE_TOKEN_REUSE') {
          void reply.code(401).send({
            error: 'Unauthorized',
            code: 'DEVICE_TOKEN_REUSE',
            message: 'Device token reuse detected; device blocked',
          });
          throw new Error('DEVICE_TOKEN_REUSE');
        }
        if (err.code === 'DEVICE_REVOKED' || err.code === 'DEVICE_BLOCKED') {
          void reply.code(403).send({
            error: 'Forbidden',
            code: err.code,
            message: 'Device has been revoked or blocked',
          });
          throw new Error(err.code);
        }
        if (err.code === 'TOKEN_EXPIRED') {
          void reply.code(401).send({
            error: 'Unauthorized',
            code: 'TOKEN_EXPIRED',
            message: 'Device token has expired',
          });
          throw new Error('TOKEN_EXPIRED');
        }
        if (err.code === 'AUTH_UNAUTHORIZED') {
          void reply.code(401).send({
            error: 'Unauthorized',
            code: 'AUTH_UNAUTHORIZED',
            message: err.message,
          });
          throw new Error('AUTH_UNAUTHORIZED');
        }
      }
      void reply.code(401).send({ error: 'Unauthorized', message: 'Device authentication failed' });
      throw new Error('DEVICE_AUTH_REQUIRED');
    }
  }

  // POST /api/v1/devices/pairing-codes (Cabinet owner)
  app.post<{ Body: CloudCreatePairingCodeRequestDto }>(
    '/api/v1/devices/pairing-codes',
    async (req, reply) => {
      let auth: CloudJwtPayload;
      try {
        auth = requireAuth(req, reply);
      } catch {
        return;
      }

      if (auth.role !== 'owner') {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Only owner can generate pairing codes',
        });
      }

      const parseResult = CloudCreatePairingCodeRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          details: parseResult.error.flatten(),
        });
      }

      const { storeId, name } = parseResult.data;
      const nowMs = clock.nowMs();

      try {
        const created = await deviceStore.createPairingCode({
          organizationId: auth.org,
          storeId: parseUuidV7(storeId),
          deviceName: name,
          idGen,
          nowMs,
        });

        const response: CloudCreatePairingCodeResponseDto = {
          code: created.code,
          expiresAtMs: Number(created.expiresAtMs),
          storeId: created.storeId,
          storeName: created.storeName,
        };

        return reply.code(201).send(response);
      } catch (err) {
        if (err instanceof DomainError && err.code === 'STORE_NOT_FOUND') {
          return reply.code(404).send({ error: 'Not Found', message: err.message });
        }
        throw err;
      }
    },
  );

  // POST /api/v1/devices/pair (Pre-auth endpoint, rate-limited: max 20 per minute)
  app.post<{ Body: CloudPairDeviceRequestDto }>(
    '/api/v1/devices/pair',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
        },
      },
    },
    async (req, reply) => {
      const parseResult = CloudPairDeviceRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          details: parseResult.error.flatten(),
        });
      }

      const { code, deviceId, platform, appVersion } = parseResult.data;
      const nowMs = clock.nowMs();

      const lookup = await deviceStore.lookupPairingCode(code);
      if (!lookup) {
        return reply.code(404).send({
          error: 'Not Found',
          code: 'PAIRING_CODE_NOT_FOUND',
          message: 'Invalid pairing code',
        });
      }

      if (lookup.usedAtMs !== null) {
        return reply.code(409).send({
          error: 'Conflict',
          code: 'PAIRING_ALREADY_USED',
          message: 'Pairing code has already been used',
        });
      }

      if (lookup.expiresAtMs < BigInt(nowMs)) {
        return reply.code(400).send({
          error: 'Bad Request',
          code: 'PAIRING_CODE_EXPIRED',
          message: 'Pairing code has expired',
        });
      }

      try {
        const paired = await deviceStore.pairDevice({
          pairingLookup: lookup,
          deviceId: parseUuidV7(deviceId),
          platform,
          appVersion,
          idGen,
          nowMs,
        });

        const response: CloudPairDeviceResponseDto = {
          deviceToken: paired.deviceToken,
          organizationId: paired.organizationId,
          storeId: paired.storeId,
          storeName: paired.storeName,
          organizationName: paired.organizationName,
        };

        return reply.code(201).send(response);
      } catch (err) {
        if (err instanceof DomainError) {
          if (err.code === 'PAIRING_ALREADY_USED') {
            return reply.code(409).send({
              error: 'Conflict',
              code: 'PAIRING_ALREADY_USED',
              message: err.message,
            });
          }
          if (err.code === 'DEVICE_ALREADY_REGISTERED') {
            return reply.code(409).send({
              error: 'Conflict',
              code: 'DEVICE_ALREADY_REGISTERED',
              message: err.message,
            });
          }
          if (err.code === 'STORE_NOT_FOUND') {
            return reply.code(404).send({
              error: 'Not Found',
              code: 'STORE_NOT_FOUND',
              message: err.message,
            });
          }
        }
        throw err;
      }
    },
  );

  // POST /api/v1/devices/rotate-token (Authenticated device)
  app.post<{ Body: CloudRotateDeviceTokenRequestDto }>(
    '/api/v1/devices/rotate-token',
    async (req, reply) => {
      let authResult: { device: VerifiedDeviceContext; token: string };
      try {
        authResult = await requireDeviceAuth(req, reply);
      } catch {
        return;
      }

      const parseResult = CloudRotateDeviceTokenRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          details: parseResult.error.flatten(),
        });
      }

      const { clientRequestId } = parseResult.data;
      const nowMs = clock.nowMs();

      try {
        const rotated = await deviceStore.rotateDeviceToken({
          currentToken: authResult.token,
          clientRequestId: parseUuidV7(clientRequestId),
          idGen,
          nowMs,
        });

        const response: CloudRotateDeviceTokenResponseDto = {
          deviceToken: rotated.deviceToken,
          expiresAtMs: rotated.expiresAtMs,
        };

        return reply.code(200).send(response);
      } catch (err) {
        if (err instanceof DomainError && err.code === 'DEVICE_TOKEN_REUSE') {
          return reply.code(401).send({
            error: 'Unauthorized',
            code: 'DEVICE_TOKEN_REUSE',
            message: 'Token reuse detected; device blocked',
          });
        }
        throw err;
      }
    },
  );

  // GET /api/v1/devices/me (Authenticated device)
  app.get('/api/v1/devices/me', async (req, reply) => {
    let authResult: { device: VerifiedDeviceContext; token: string };
    try {
      authResult = await requireDeviceAuth(req, reply);
    } catch {
      return;
    }

    return reply.code(200).send({
      deviceId: authResult.device.deviceId,
      organizationId: authResult.device.organizationId,
      storeId: authResult.device.storeId,
      deviceName: authResult.device.deviceName,
      status: authResult.device.status,
    });
  });

  // POST /api/v1/devices/:id/revoke (Cabinet owner)
  app.post<{ Params: { id: string } }>('/api/v1/devices/:id/revoke', async (req, reply) => {
    let auth: CloudJwtPayload;
    try {
      auth = requireAuth(req, reply);
    } catch {
      return;
    }

    if (auth.role !== 'owner') {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Only owner can revoke devices',
      });
    }

    let deviceDbId: UuidV7;
    try {
      deviceDbId = parseUuidV7(req.params.id);
    } catch {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid device id' });
    }

    const nowMs = clock.nowMs();
    try {
      await deviceStore.revokeDevice({
        organizationId: auth.org,
        deviceDbId,
        nowMs,
      });

      return reply.code(200).send({ success: true, status: 'revoked' });
    } catch (err) {
      if (err instanceof DomainError && err.code === 'DEVICE_NOT_FOUND') {
        return reply.code(404).send({ error: 'Not Found', message: err.message });
      }
      throw err;
    }
  });

  // POST /api/v1/sync/push (Hub outbox sync push engine)
  app.post<{ Body: SyncPushRequestDto }>('/api/v1/sync/push', async (req, reply) => {
    let auth: { device: VerifiedDeviceContext; token: string };
    try {
      auth = await requireDeviceAuth(req, reply);
    } catch {
      return;
    }

    const parseResult = SyncPushRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        details: parseResult.error.flatten(),
      });
    }

    const { clientVersion, storeId, deviceId, events } = parseResult.data;

    // Version check: Clients below MIN_CLIENT_VERSION receive 426 Upgrade Required
    if (!isVersionSupported(clientVersion, MIN_CLIENT_VERSION)) {
      return reply.code(426).send({
        error: 'Upgrade Required',
        code: 'CLIENT_VERSION_UNSUPPORTED',
        message: `Client version ${clientVersion} is unsupported; minimum required is ${MIN_CLIENT_VERSION}`,
        minVersion: MIN_CLIENT_VERSION,
      });
    }

    // Verify requesting store and device match token context
    if (storeId !== auth.device.storeId || deviceId !== auth.device.deviceId) {
      return reply.code(403).send({
        error: 'Forbidden',
        code: 'DEVICE_STORE_MISMATCH',
        message: 'Push payload storeId or deviceId does not match authenticated token',
      });
    }

    const nowMs = clock.nowMs();
    const result: SyncPushResponseDto = await syncPushStore.processSyncPushBatch({
      context: auth.device,
      events,
      nowMs,
    });

    return reply.code(200).send(result);
  });

  // Admin Cabinet API routes (T2.7a)
  // T2.8 Telegram bot: enabled only when the token and the webhook secret are configured.
  const telegramStore = new CloudTelegramStore(conn.pool, idGen);
  let telegramBot: TelegramBotService | undefined;
  let telegramScheduler: TelegramScheduler | null = null;
  if (isTelegramEnabled(config)) {
    const client =
      options.telegramClient ?? new HttpTelegramClient({ token: config.telegramBotToken ?? '' });
    telegramBot = new TelegramBotService({
      store: telegramStore,
      client,
      clock,
      digestHour: config.telegramDigestHour,
      logger: app.log,
    });
    telegramScheduler = new TelegramScheduler({
      store: telegramStore,
      adminStore,
      client,
      clock,
      digestHour: config.telegramDigestHour,
      reminderHour: config.telegramReminderHour,
      logger: app.log,
    });
    const scheduler = telegramScheduler;
    app.addHook('onClose', () => {
      scheduler.stop();
      return Promise.resolve();
    });
  }
  app.decorate('telegramScheduler', telegramScheduler);
  await registerTelegramRoutes(app, {
    config,
    jwtService,
    store: telegramStore,
    bot: telegramBot,
    clock,
  });

  await registerAdminRoutes(app, {
    config,
    conn,
    jwtService,
    authStore,
    adminStore,
    clock,
  });
  // GET /api/v1/sync/pull (Hub sync pull engine - T2.4)
  app.get<{ Querystring: { cursors?: string; limit?: string } }>(
    '/api/v1/sync/pull',
    async (req, reply) => {
      let auth: { device: VerifiedDeviceContext; token: string };
      try {
        auth = await requireDeviceAuth(req, reply);
      } catch {
        return;
      }

      const parseQuery = SyncPullQuerySchema.safeParse(req.query);
      if (!parseQuery.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          code: 'INVALID_QUERY',
          message: parseQuery.error.message,
        });
      }

      const { cursors: cursorsStr, limit } = parseQuery.data;
      const parsedCursors = parseAndValidateSyncCursors(cursorsStr);
      if (!parsedCursors.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          code: 'INVALID_CURSORS',
          message: parsedCursors.error,
        });
      }

      try {
        const pullResult: SyncPullResponseDto = await syncPullStore.getSyncPullEvents({
          context: auth.device,
          cursors: parsedCursors.cursors,
          limit,
        });
        return reply.code(200).send(pullResult);
      } catch (err: unknown) {
        if (err instanceof ForeignStoreError) {
          return reply.code(400).send({
            error: 'Bad Request',
            code: 'FOREIGN_STORE_ID',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      }
    },
  );

  return app;
}

function isVersionSupported(clientVersion: string, minVersion: string): boolean {
  const [cMaj = 0, cMin = 0, cPatch = 0] = clientVersion.split('.').map(Number);
  const [mMaj = 0, mMin = 0, mPatch = 0] = minVersion.split('.').map(Number);
  if (cMaj !== mMaj) return cMaj > mMaj;
  if (cMin !== mMin) return cMin > mMin;
  return cPatch >= mPatch;
}
