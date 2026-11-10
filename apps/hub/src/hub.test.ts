import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { ApiErrorEnvelopeSchema } from '@mezon/contracts';
import { listAllOutboxRecordsSync, localPinCredentials } from '@mezon/db-local';
import type { PinHasher, UuidV7 } from '@mezon/domain';
import { DeterministicUuidV7Generator, FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { ARGON2ID_PHC_PREFIX, Argon2PinHasher, createHubServer, hashBearerToken } from './index.js';

const tempDirs: string[] = [];
const TEST_PORT = 47832;
const DEFAULT_HOST_HEADER = `127.0.0.1:${TEST_PORT}`;

function makeDbPath(name = 'hub.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-test-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

function makeFastTestHasher(): PinHasher {
  return {
    hash(pin: string): Promise<string> {
      return Promise.resolve(`fast-stub-hash:${pin}`);
    },
    verify(storedHash: string, pin: string): Promise<boolean> {
      return Promise.resolve(storedHash === `fast-stub-hash:${pin}`);
    },
  };
}

function authHeaders(
  token: string,
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    host: DEFAULT_HOST_HEADER,
    authorization: `Bearer ${token}`,
    ...extra,
  };
}

function loopHeaders(extra?: Readonly<Record<string, string>>): Record<string, string> {
  return {
    host: DEFAULT_HOST_HEADER,
    ...extra,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('@mezon/hub - HTTP security, Argon2id PIN auth, setup wizard, RBAC, and Pino logging', () => {
  it('enforces 127.0.0.1 bind, Host check (DNS rebinding), Origin allowlist, closed CORS, and Bearer auth (a)', async () => {
    await expect(
      createHubServer({
        dbPath: makeDbPath('bad-host.db'),
        host: '0.0.0.0',
        logLevel: 'silent',
        pinHasher: makeFastTestHasher(),
      }),
    ).rejects.toThrow(/127\.0\.0\.1/);

    const hub = await createHubServer({
      dbPath: makeDbPath('security.db'),
      port: TEST_PORT,
      allowedOrigins: ['http://127.0.0.1:5173'],
      logLevel: 'silent',
      pinHasher: makeFastTestHasher(),
    });

    try {
      // Malicious / rebinding / wrong-port / malformed Host headers -> 421 INVALID_HOST
      for (const badHost of [
        undefined,
        'evil.uz:47832',
        '127.0.0.1.evil.uz:47832',
        '192.168.1.25:47832',
        'localhost:80',
        '127.0.0.1',
        '127.0.0.1:47832, evil.uz:47832',
      ]) {
        const res = await hub.app.inject({
          method: 'GET',
          url: '/health',
          headers: badHost === undefined ? {} : { host: badHost },
        });
        expect(res.statusCode).toBe(421);
        const body = ApiErrorEnvelopeSchema.parse(res.json());
        expect(body.error.code).toBe('INVALID_HOST');
      }

      // Even unknown routes run Host check BEFORE 404 handler
      const badHostMissingRoute = await hub.app.inject({
        method: 'GET',
        url: '/nonexistent',
        headers: { host: 'attacker.example:47832' },
      });
      expect(badHostMissingRoute.statusCode).toBe(421);

      // Valid Host (127.0.0.1:<port> and localhost:<port>) succeeds without Origin (non-browser)
      expect(
        (
          await hub.app.inject({
            method: 'GET',
            url: '/health',
            headers: { host: `127.0.0.1:${TEST_PORT}` },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await hub.app.inject({
            method: 'GET',
            url: '/health',
            headers: { host: `localhost:${TEST_PORT}` },
          })
        ).statusCode,
      ).toBe(200);

      // Browser Origin checks & closed CORS
      for (const badOrigin of [
        'https://evil.uz',
        'http://localhost:9999',
        'http://127.0.0.1:5173.evil.uz',
        'null',
      ]) {
        const res = await hub.app.inject({
          method: 'POST',
          url: '/setup',
          headers: loopHeaders({ origin: badOrigin }),
          payload: {},
        });
        expect(res.statusCode).toBe(403);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
        expect(ApiErrorEnvelopeSchema.parse(res.json()).error.code).toBe('FORBIDDEN_ORIGIN');
      }

      // Cross-site Sec-Fetch-Site rejected even without Origin header
      const crossSiteRes = await hub.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: loopHeaders({ 'sec-fetch-site': 'cross-site' }),
        payload: {},
      });
      expect(crossSiteRes.statusCode).toBe(403);

      // CORS OPTIONS preflight strictly rejected with zero Access-Control-* headers
      const preflightRes = await hub.app.inject({
        method: 'OPTIONS',
        url: '/auth/login',
        headers: loopHeaders({
          origin: 'http://127.0.0.1:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type',
        }),
      });
      expect(preflightRes.statusCode).toBe(403);
      expect(preflightRes.headers['access-control-allow-origin']).toBeUndefined();
      expect(preflightRes.headers['access-control-allow-headers']).toBeUndefined();
      expect(preflightRes.headers['access-control-allow-methods']).toBeUndefined();

      // Explicitly allowlisted origin can pass simple request while CORS headers remain absent
      const allowedOriginRes = await hub.app.inject({
        method: 'GET',
        url: '/health',
        headers: loopHeaders({ origin: 'http://127.0.0.1:5173' }),
      });
      expect(allowedOriginRes.statusCode).toBe(200);
      expect(allowedOriginRes.headers['access-control-allow-origin']).toBeUndefined();
      expect(allowedOriginRes.headers['set-cookie']).toBeUndefined();

      // Cookie header is ignored; protected endpoint requires Bearer header
      const cookieOnly = await hub.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: loopHeaders({ cookie: 'session=spoofed-token' }),
      });
      expect(cookieOnly.statusCode).toBe(401);
      expect(cookieOnly.headers['set-cookie']).toBeUndefined();
    } finally {
      await hub.close();
    }

    // Real ephemeral TCP socket on 127.0.0.1:0
    const liveHub = await createHubServer({
      dbPath: makeDbPath('live-socket.db'),
      port: 0,
      logLevel: 'silent',
      pinHasher: makeFastTestHasher(),
    });
    try {
      const bound = await liveHub.listen();
      expect(bound.host).toBe('127.0.0.1');
      expect(bound.port).toBeGreaterThan(0);

      const response = await fetch(`http://127.0.0.1:${bound.port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: 'ok',
        service: '@mezon/hub',
        needsSetup: true,
      });
    } finally {
      await liveHub.close();
    }
  });

  it('closes setup wizard permanently after first completion and allows only 1 winner under concurrency (d)', async () => {
    const clock = new FixedClock(1_700_000_000_000n);
    const hub = await createHubServer({
      dbPath: makeDbPath('setup-concurrent.db'),
      port: TEST_PORT,
      logLevel: 'silent',
      clock,
      random: new SeededRandomSource(201),
      pinHasher: makeFastTestHasher(),
    });

    try {
      // Weak PINs rejected before setup completes
      for (const badPin of ['123456', '000000', '654321', '12345', '84920a']) {
        const badRes = await hub.app.inject({
          method: 'POST',
          url: '/setup',
          headers: loopHeaders(),
          payload: { owner: { fullName: 'Ega', username: 'owner', pin: badPin } },
        });
        expect(badRes.statusCode).toBe(400);
        expect(badRes.body).not.toContain(badPin);
      }

      // Race two parallel setup requests -> strictly one 201 and one 409 SETUP_ALREADY_COMPLETED
      const [s1, s2] = await Promise.all([
        hub.app.inject({
          method: 'POST',
          url: '/setup',
          headers: loopHeaders(),
          payload: { owner: { fullName: 'Owner A', username: 'ownera', pin: '839204' } },
        }),
        hub.app.inject({
          method: 'POST',
          url: '/setup',
          headers: loopHeaders(),
          payload: { owner: { fullName: 'Owner B', username: 'ownerb', pin: '940281' } },
        }),
      ]);

      const statuses = [s1.statusCode, s2.statusCode].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);

      const winner =
        s1.statusCode === 201
          ? s1.json<{ owner: { id: UuidV7 }; organizationId: UuidV7 }>()
          : s2.json<{ owner: { id: UuidV7 }; organizationId: UuidV7 }>();
      const loser =
        s1.statusCode === 409
          ? ApiErrorEnvelopeSchema.parse(s1.json())
          : ApiErrorEnvelopeSchema.parse(s2.json());
      expect(loser.error.code).toBe('SETUP_ALREADY_COMPLETED');
      expect(winner.owner.id).toBeTruthy();

      // Any subsequent setup request is rejected with 409
      const third = await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: loopHeaders(),
        payload: { owner: { fullName: 'Third', username: 'third', pin: '729104' } },
      });
      expect(third.statusCode).toBe(409);

      // Health now reports needsSetup: false
      const health = await hub.app.inject({
        method: 'GET',
        url: '/health',
        headers: loopHeaders(),
      });
      expect(health.json()).toEqual({ status: 'ok', service: '@mezon/hub', needsSetup: false });

      // Default 'admin'/'admin' login is impossible
      const adminRes = await hub.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: loopHeaders(),
        payload: { username: 'admin', pin: 'admin' },
      });
      expect(adminRes.statusCode).toBe(401);
    } finally {
      await hub.close();
    }
  });

  it('uses real @node-rs/argon2 Argon2id, invokes verify for unknown users (constant timing work), and redacts all secrets from Pino logs (b, f)', async () => {
    const dbPath = makeDbPath('argon2-pino.db');
    const logStream = new PassThrough();
    let capturedLogs = '';
    logStream.on('data', (chunk: Buffer) => {
      capturedLogs += chunk.toString('utf8');
    });

    const realHasher = new Argon2PinHasher();
    let verifyCallCount = 0;
    const verifiedHashes: string[] = [];
    const spyHasher: PinHasher = {
      hash(pin: string) {
        return realHasher.hash(pin);
      },
      async verify(storedHash: string, pin: string) {
        verifyCallCount += 1;
        verifiedHashes.push(storedHash);
        return realHasher.verify(storedHash, pin);
      },
    };

    const clock = new FixedClock(1_700_000_000_000n);
    const hub = await createHubServer({
      dbPath,
      port: TEST_PORT,
      clock,
      random: new SeededRandomSource(202),
      pinHasher: spyHasher,
      logLevel: 'info',
      logStream,
      registerExtraTestRoutes: (app) => {
        app.get('/__test-boom', () => {
          throw new Error('SECRET_DB_PASSWORD=topsecret sqlite internal crash');
        });
      },
    });

    const ownerPin = '739205';
    const wrongPin = '998877';

    try {
      const setupRes = await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: loopHeaders(),
        payload: { owner: { fullName: 'Main Owner', username: 'owner', pin: ownerPin } },
      });
      expect(setupRes.statusCode).toBe(201);

      // Inspect stored hash format directly -> strict OWASP Argon2id parameters
      const storedCred = hub.connection.db.select().from(localPinCredentials).all()[0];
      expect(storedCred.pinHash.startsWith(ARGON2ID_PHC_PREFIX)).toBe(true);

      // Unknown username MUST still invoke real Argon2id verify (timing oracle defense)
      verifyCallCount = 0;
      const unknownStart = performance.now();
      const unknownRes = await hub.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: loopHeaders(),
        payload: { username: 'does_not_exist', pin: ownerPin },
      });
      const unknownElapsedMs = performance.now() - unknownStart;
      expect(unknownRes.statusCode).toBe(401);
      expect(verifyCallCount).toBe(1);
      expect(verifiedHashes[0]?.startsWith(ARGON2ID_PHC_PREFIX)).toBe(true);
      expect(ApiErrorEnvelopeSchema.parse(unknownRes.json())).toEqual({
        error: {
          code: 'AUTH_INVALID_CREDENTIALS',
          message: 'AUTH_INVALID_CREDENTIALS: Invalid credentials',
        },
      });

      // Valid username, wrong PIN takes comparable Argon2id work & returns identical 401 envelope
      verifyCallCount = 0;
      const wrongStart = performance.now();
      const wrongRes = await hub.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: loopHeaders(),
        payload: { username: 'owner', pin: wrongPin },
      });
      const wrongElapsedMs = performance.now() - wrongStart;
      expect(wrongRes.statusCode).toBe(401);
      expect(verifyCallCount).toBe(1);
      expect(unknownElapsedMs).toBeGreaterThan(3);
      expect(wrongElapsedMs).toBeGreaterThan(3);
      expect(wrongRes.json()).toEqual(unknownRes.json());

      // Successful login
      const okRes = await hub.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: loopHeaders(),
        payload: { username: 'owner', pin: ownerPin },
      });
      expect(okRes.statusCode).toBe(200);
      const { token } = okRes.json<{ token: string }>();
      const tokenHash = hashBearerToken(token);

      // Direct secret logging test through Pino child logger + Bearer auth request logging
      hub.app.log.info(
        {
          pin: ownerPin,
          nested: { token, pinHash: storedCred.pinHash, tokenHash },
        },
        'audit check',
      );
      const meRes = await hub.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: authHeaders(token),
      });
      expect(meRes.statusCode).toBe(200);

      // Unexpected 500 error never exposes stack trace or internal error message to HTTP client
      const boomRes = await hub.app.inject({
        method: 'GET',
        url: '/__test-boom',
        headers: loopHeaders(),
      });
      expect(boomRes.statusCode).toBe(500);
      expect(ApiErrorEnvelopeSchema.parse(boomRes.json())).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      });
      expect(boomRes.body).not.toContain('topsecret');
      expect(boomRes.body).not.toContain('hub.test.ts');

      // Malformed JSON and missing routes follow unified { error: { code, message } } shape
      const badJsonRes = await hub.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { ...loopHeaders(), 'content-type': 'application/json' },
        payload: '{bad-json',
      });
      expect(badJsonRes.statusCode).toBe(400);
      expect(ApiErrorEnvelopeSchema.parse(badJsonRes.json()).error.code).toBe('BAD_REQUEST');

      const missingRouteRes = await hub.app.inject({
        method: 'GET',
        url: '/no-such-route',
        headers: loopHeaders(),
      });
      expect(missingRouteRes.statusCode).toBe(404);
      expect(ApiErrorEnvelopeSchema.parse(missingRouteRes.json()).error.code).toBe('NOT_FOUND');

      // Inspect every captured Pino NDJSON line -> ZERO raw PINs, hashes, tokens, or tokenHashes
      const lines = capturedLogs
        .trim()
        .split(/\r?\n/)
        .filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(typeof parsed.level).toBe('number');
        expect(line).not.toContain(ownerPin);
        expect(line).not.toContain(wrongPin);
        expect(line).not.toContain('$argon2id$');
        expect(line).not.toContain(token);
        expect(line).not.toContain(tokenHash);
      }
      expect(capturedLogs).toContain('[Redacted]');
    } finally {
      await hub.close();
    }
  }, 30_000);

  it('commits failed attempts (T2), persists 5-attempt user lock & progressive device 2..60s backoff across restarts (T1), and allows owner login after cooldown', async () => {
    const dbPath = makeDbPath('lockouts-backoff.db');
    const clock = new FixedClock(1_700_001_000_000n);
    const hasher = makeFastTestHasher();

    let ownerId!: UuidV7;
    let cashierId!: UuidV7;

    {
      const hub = await createHubServer({
        dbPath,
        port: TEST_PORT,
        clock,
        random: new SeededRandomSource(203),
        pinHasher: hasher,
        logLevel: 'silent',
      });

      try {
        const setupRes = await hub.app.inject({
          method: 'POST',
          url: '/setup',
          headers: loopHeaders(),
          payload: { owner: { fullName: 'Owner', username: 'owner', pin: '839204' } },
        });
        expect(setupRes.statusCode).toBe(201);
        ownerId = setupRes.json<{ owner: { id: UuidV7 } }>().owner.id;

        const loginOwner = await hub.app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: loopHeaders(),
          payload: { username: 'owner', pin: '839204' },
        });
        const ownerToken = loginOwner.json<{ token: string }>().token;

        const addCashier = await hub.app.inject({
          method: 'POST',
          url: '/users',
          headers: authHeaders(ownerToken),
          payload: { fullName: 'Cashier', username: 'cashier1', role: 'cashier', pin: '749102' },
        });
        expect(addCashier.statusCode).toBe(201);
        cashierId = addCashier.json<{ user: { id: UuidV7 } }>().user.id;

        // T2: 5 wrong PINs on cashier1 commit failed_attempts = 5 & locked_until_ms cleanly
        for (let i = 0; i < 5; i++) {
          clock.advance(100n);
          const failRes = await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: loopHeaders(),
            payload: { userId: cashierId, pin: '919191' },
          });
          expect(failRes.statusCode).toBe(401);
        }

        const rawCred = hub.connection.sqlite
          .prepare<
            [string],
            { readonly failed_attempts: bigint; readonly locked_until_ms: bigint }
          >('SELECT failed_attempts, locked_until_ms FROM local_pin_credentials WHERE user_id = ?')
          .get(cashierId);
        expect(rawCred?.failed_attempts).toBe(5n);
        expect(rawCred?.locked_until_ms).toBe(clock.now() + 300_000n);

        // Even right PIN returns 429 while locked
        const lockedAttempt = await hub.app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: loopHeaders(),
          payload: { userId: cashierId, pin: '749102' },
        });
        expect(lockedAttempt.statusCode).toBe(429);
        expect(ApiErrorEnvelopeSchema.parse(lockedAttempt.json()).error.code).toBe(
          'AUTH_RATE_LIMITED',
        );
        expect(lockedAttempt.headers['retry-after']).toBe('300');

        // T1: Continue spraying across different/unknown usernames (device fails 6..15 -> 15 triggers 2s delay!)
        for (let attempt = 6; attempt <= 15; attempt++) {
          clock.advance(10n);
          const sprayRes = await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: loopHeaders(),
            payload: { username: `spray_${attempt}`, pin: '919191' },
          });
          expect(sprayRes.statusCode).toBe(401);
        }

        // Immediately before 2s delay elapses -> 429 Retry-After: 2
        const tooSoon1 = await hub.app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: loopHeaders(),
          payload: { userId: ownerId, pin: '839204' },
        });
        expect(tooSoon1.statusCode).toBe(429);
        expect(tooSoon1.headers['retry-after']).toBe('2');

        // Verify exponential delays across failures 16, 17, 18, 19, 20, 21 -> 4, 8, 16, 32, 60, 60
        const expectedDelaysSec = [2, 4, 8, 16, 32, 60, 60];
        for (let step = 0; step < expectedDelaysSec.length - 1; step++) {
          const waitSec = expectedDelaysSec[step];
          const nextWaitSec = expectedDelaysSec[step + 1];
          clock.advance(BigInt(waitSec) * 1_000n);

          // Fail again across another username -> sets next exponential wait!
          const nextFail = await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: loopHeaders(),
            payload: { username: `spray_step_${step}`, pin: '919191' },
          });
          expect(nextFail.statusCode).toBe(401);

          const tooSoon = await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: loopHeaders(),
            payload: { username: 'owner', pin: '839204' },
          });
          expect(tooSoon.statusCode).toBe(429);
          expect(tooSoon.headers['retry-after']).toBe(String(nextWaitSec));
        }
      } finally {
        await hub.close();
      }
    }

    // Reopen fresh hub instance (simulates process restart!) -> BOTH user lock & device 60s delay persist
    {
      const restartedHub = await createHubServer({
        dbPath,
        port: TEST_PORT,
        clock,
        random: new SeededRandomSource(204),
        pinHasher: hasher,
        logLevel: 'silent',
      });

      try {
        const stillInDeviceCooldown = await restartedHub.app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: loopHeaders(),
          payload: { username: 'owner', pin: '839204' },
        });
        expect(stillInDeviceCooldown.statusCode).toBe(429);
        expect(stillInDeviceCooldown.headers['retry-after']).toBe('60');

        // Once 60s cooldown elapses, owner CAN immediately log in cleanly!
        clock.advance(60_000n);
        const ownerOk = await restartedHub.app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: loopHeaders(),
          payload: { userId: ownerId, pin: '839204' },
        });
        expect(ownerOk.statusCode).toBe(200);
        const ownerToken = ownerOk.json<{ token: string }>().token;

        // Cashier is STILL locked (remaining < 300s), until elapsed OR unlocked by owner/manager!
        const cashierStillLocked = await restartedHub.app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: loopHeaders(),
          payload: { userId: cashierId, pin: '749102' },
        });
        expect(cashierStillLocked.statusCode).toBe(429);

        // Owner unlocks cashier (T3) -> immediately succeeds
        const unlockRes = await restartedHub.app.inject({
          method: 'POST',
          url: `/users/${cashierId}/unlock`,
          headers: authHeaders(ownerToken),
        });
        expect(unlockRes.statusCode).toBe(200);

        const cashierNowOk = await restartedHub.app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: loopHeaders(),
          payload: { userId: cashierId, pin: '749102' },
        });
        expect(cashierNowOk.statusCode).toBe(200);
      } finally {
        await restartedHub.close();
      }
    }
  });

  it('enforces Role x Endpoint matrix (e, T3), login-options + userId login (T6), session lifecycle & throttling (T4), and username reuse after tombstone (T5)', async () => {
    const clock = new FixedClock(1_700_002_000_000n);
    const hub = await createHubServer({
      dbPath: makeDbPath('rbac-lifecycle.db'),
      port: TEST_PORT,
      clock,
      random: new SeededRandomSource(205),
      pinHasher: makeFastTestHasher(),
      logLevel: 'silent',
    });

    try {
      // Setup owner & login
      const setupRes = await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: loopHeaders(),
        payload: { owner: { fullName: 'Big Owner', username: 'owner', pin: '839204' } },
      });
      expect(setupRes.statusCode).toBe(201);
      const ownerId = setupRes.json<{ owner: { id: UuidV7 } }>().owner.id;

      const loginOwner = await hub.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: loopHeaders(),
        payload: { username: 'owner', pin: '839204' },
      });
      const ownerToken = loginOwner.json<{ token: string }>().token;

      // Create manager and cashier
      const mgrCreate = await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerToken),
        payload: { fullName: 'Branch Manager', username: 'mgr1', role: 'manager', pin: '294810' },
      });
      expect(mgrCreate.statusCode).toBe(201);
      const managerId = mgrCreate.json<{ user: { id: UuidV7 } }>().user.id;

      const cshCreate = await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerToken),
        payload: {
          fullName: 'Front Cashier',
          username: 'cashier1',
          role: 'cashier',
          pin: '719304',
        },
      });
      expect(cshCreate.statusCode).toBe(201);
      const cashierId = cshCreate.json<{ user: { id: UuidV7 } }>().user.id;

      // T6: Public GET /auth/login-options lists only active { id, fullName, role }
      const optsRes = await hub.app.inject({
        method: 'GET',
        url: '/auth/login-options',
        headers: loopHeaders(),
      });
      expect(optsRes.statusCode).toBe(200);
      const options = optsRes.json<{ options: Array<Record<string, unknown>> }>().options;
      expect(options).toHaveLength(3);
      for (const opt of options) {
        expect(Object.keys(opt).sort()).toEqual(['fullName', 'id', 'role']);
      }

      // Login via userId + PIN works cleanly for both manager & cashier
      const loginMgr = await hub.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: loopHeaders(),
        payload: { userId: managerId, pin: '294810' },
      });
      const mgrToken = loginMgr.json<{ token: string }>().token;

      const loginCashier = await hub.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: loopHeaders(),
        payload: { userId: cashierId, pin: '719304' },
      });
      const cashierToken = loginCashier.json<{ token: string }>().token;

      // Role x Endpoint Matrix
      const matrixCases: Array<{
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
        url: string;
        payload?: Record<string, unknown>;
        unauth: number;
        cashier: number;
        manager: number;
        owner: number;
      }> = [
        { method: 'GET', url: '/auth/me', unauth: 401, cashier: 200, manager: 200, owner: 200 },
        { method: 'GET', url: '/users', unauth: 401, cashier: 403, manager: 200, owner: 200 },
        {
          method: 'POST',
          url: '/users',
          payload: { fullName: 'Probe User', username: 'probe_u', role: 'cashier', pin: '810293' },
          unauth: 401,
          cashier: 403,
          manager: 403,
          owner: 201,
        },
        {
          method: 'PATCH',
          url: `/users/${cashierId}`,
          payload: { fullName: 'Front Cashier Updated' },
          unauth: 401,
          cashier: 403,
          manager: 403,
          owner: 200,
        },
        {
          method: 'POST',
          url: `/users/${cashierId}/unlock`,
          unauth: 401,
          cashier: 403,
          manager: 200,
          owner: 200,
        },
        {
          method: 'POST',
          url: `/users/${cashierId}/pin`,
          payload: { pin: '582910' },
          unauth: 401,
          cashier: 403,
          manager: 403,
          owner: 200,
        },
      ];

      for (const tc of matrixCases) {
        const unauthRes = await hub.app.inject({
          method: tc.method,
          url: tc.url,
          headers: loopHeaders(),
          payload: tc.payload,
        });
        expect(unauthRes.statusCode, `unauth ${tc.method} ${tc.url}`).toBe(tc.unauth);

        const cRes = await hub.app.inject({
          method: tc.method,
          url: tc.url,
          headers: authHeaders(cashierToken),
          payload: tc.payload,
        });
        expect(cRes.statusCode, `cashier ${tc.method} ${tc.url}`).toBe(tc.cashier);

        const mRes = await hub.app.inject({
          method: tc.method,
          url: tc.url,
          headers: authHeaders(mgrToken),
          payload: tc.payload,
        });
        expect(mRes.statusCode, `manager ${tc.method} ${tc.url}`).toBe(tc.manager);

        const oRes = await hub.app.inject({
          method: tc.method,
          url: tc.url,
          headers: authHeaders(ownerToken),
          payload: tc.payload,
        });
        expect(oRes.statusCode, `owner ${tc.method} ${tc.url}`).toBe(tc.owner);
      }

      // Previous cashierToken was invalidated automatically by PIN reset!
      const revokedByPinReset = await hub.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: authHeaders(cashierToken),
      });
      expect(revokedByPinReset.statusCode).toBe(401);

      // New PIN works, then verify DELETE /users/:id matrix across all 4 roles
      const cashierRelogin = await hub.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: loopHeaders(),
        payload: { userId: cashierId, pin: '582910' },
      });
      expect(cashierRelogin.statusCode).toBe(200);
      const cashierToken2 = cashierRelogin.json<{ token: string }>().token;

      expect(
        (
          await hub.app.inject({
            method: 'DELETE',
            url: `/users/${cashierId}`,
            headers: loopHeaders(),
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await hub.app.inject({
            method: 'DELETE',
            url: `/users/${cashierId}`,
            headers: authHeaders(cashierToken2),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await hub.app.inject({
            method: 'DELETE',
            url: `/users/${cashierId}`,
            headers: authHeaders(mgrToken),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await hub.app.inject({
            method: 'DELETE',
            url: `/users/${cashierId}`,
            headers: authHeaders(ownerToken),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await hub.app.inject({
            method: 'GET',
            url: '/auth/me',
            headers: authHeaders(cashierToken2),
          })
        ).statusCode,
      ).toBe(401);

      // Tombstoned cashier is excluded from login-options and login fails, and username 'cashier1' CAN be reused (T5)!
      const optsAfterDelete = (
        await hub.app.inject({ method: 'GET', url: '/auth/login-options', headers: loopHeaders() })
      ).json<{ options: Array<{ id: UuidV7 }> }>().options;
      expect(optsAfterDelete.some((o) => o.id === cashierId)).toBe(false);
      expect(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: loopHeaders(),
            payload: { userId: cashierId, pin: '582910' },
          })
        ).statusCode,
      ).toBe(401);

      const reuseUsername = await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerToken),
        payload: {
          fullName: 'Rehired Cashier',
          username: 'cashier1',
          role: 'cashier',
          pin: '391048',
        },
      });
      expect(reuseUsername.statusCode).toBe(201);
      const rehiredId = reuseUsername.json<{ user: { id: UuidV7 } }>().user.id;
      expect(rehiredId).not.toBe(cashierId);

      // Disabling active user immediately revokes their session and prevents login
      const rehiredLogin = await hub.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: loopHeaders(),
        payload: { userId: rehiredId, pin: '391048' },
      });
      const rehiredToken = rehiredLogin.json<{ token: string }>().token;
      const disableRes = await hub.app.inject({
        method: 'PATCH',
        url: `/users/${rehiredId}`,
        headers: authHeaders(ownerToken),
        payload: { isActive: false },
      });
      expect(disableRes.statusCode).toBe(200);
      expect(
        (
          await hub.app.inject({
            method: 'GET',
            url: '/auth/me',
            headers: authHeaders(rehiredToken),
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: loopHeaders(),
            payload: { userId: rehiredId, pin: '391048' },
          })
        ).statusCode,
      ).toBe(401);

      // Cannot delete/demote last active owner -> 409 LAST_OWNER_PROTECTED
      const delLastOwner = await hub.app.inject({
        method: 'DELETE',
        url: `/users/${ownerId}`,
        headers: authHeaders(ownerToken),
      });
      expect(delLastOwner.statusCode).toBe(409);

      // T4: last_seen_at_ms throttling (>= 60s) + expiry + explicit logout
      const ownerTokenHash = hashBearerToken(ownerToken);
      const readLastSeen = () =>
        hub.connection.sqlite
          .prepare<[string], { readonly last_seen_at_ms: bigint }>(
            'SELECT last_seen_at_ms FROM local_sessions WHERE token_hash = ?',
          )
          .get(ownerTokenHash);

      const ownerSessionBefore = readLastSeen();
      expect(ownerSessionBefore).toBeDefined();
      clock.advance(20_000n); // < 60s
      await hub.app.inject({ method: 'GET', url: '/auth/me', headers: authHeaders(ownerToken) });
      const ownerSessionSoon = readLastSeen();
      expect(ownerSessionSoon?.last_seen_at_ms).toBe(ownerSessionBefore?.last_seen_at_ms);

      clock.advance(45_000n); // total 65s >= 60s
      await hub.app.inject({ method: 'GET', url: '/auth/me', headers: authHeaders(ownerToken) });
      const ownerSessionLater = readLastSeen();
      expect(ownerSessionLater?.last_seen_at_ms).toBe(clock.now());

      // Outbox contains ONLY user ATTR mutations (zero local_pin_credentials, zero local_sessions)
      const outbox = listAllOutboxRecordsSync(hub.connection.db);
      expect(outbox.every((e) => e.entity === 'users' && e.class === 'ATTR')).toBe(true);

      // Logout requires auth (unauth -> 401), and revokes manager token immediately (200 -> subsequent 401)
      expect(
        (await hub.app.inject({ method: 'POST', url: '/auth/logout', headers: loopHeaders() }))
          .statusCode,
      ).toBe(401);
      const logoutRes = await hub.app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: authHeaders(mgrToken),
      });
      expect(logoutRes.statusCode).toBe(200);
      expect(
        (await hub.app.inject({ method: 'GET', url: '/auth/me', headers: authHeaders(mgrToken) }))
          .statusCode,
      ).toBe(401);

      // Session expiry (+12h) expires owner token
      clock.advance(43_200_000n);
      expect(
        (await hub.app.inject({ method: 'GET', url: '/auth/me', headers: authHeaders(ownerToken) }))
          .statusCode,
      ).toBe(401);

      // Unused generator check silence removed cleanly (helper check)
      expect(new DeterministicUuidV7Generator().nextId()).not.toBe(ownerId);
    } finally {
      await hub.close();
    }
  });

  it('rejects in-flight login when PIN is reset mid-verification (TOCTOU R1) without creating a session or incrementing failed_attempts', async () => {
    const clock = new FixedClock(1_700_003_000_000n);
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let verifyStarted!: () => void;
    const verifyStartedPromise = new Promise<void>((resolve) => {
      verifyStarted = resolve;
    });

    let trackSlowVerify = false;
    const controlledHasher: PinHasher = {
      hash(pin: string): Promise<string> {
        return Promise.resolve(`slow-stub:${pin}`);
      },
      async verify(storedHash: string, pin: string): Promise<boolean> {
        if (trackSlowVerify) {
          verifyStarted();
        }
        await delay(300);
        return storedHash === `slow-stub:${pin}`;
      },
    };

    const hub = await createHubServer({
      dbPath: makeDbPath('r1-toctou-pin-reset.db'),
      port: TEST_PORT,
      clock,
      random: new SeededRandomSource(206),
      pinHasher: controlledHasher,
      logLevel: 'silent',
    });

    try {
      const setupRes = await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: loopHeaders(),
        payload: { owner: { fullName: 'Race Owner', username: 'owner', pin: '839204' } },
      });
      expect(setupRes.statusCode).toBe(201);
      const ownerId = setupRes.json<{ owner: { id: UuidV7 } }>().owner.id;

      const firstLogin = await hub.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: loopHeaders(),
        payload: { userId: ownerId, pin: '839204' },
      });
      expect(firstLogin.statusCode).toBe(200);
      const ownerToken1 = firstLogin.json<{ token: string }>().token;

      // Start delayed login with old PIN (verify takes 300ms)
      trackSlowVerify = true;
      const pLateLogin = hub.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: loopHeaders(),
        payload: { userId: ownerId, pin: '839204' },
      });

      // Wait until Phase 2 verify is actively in flight (~60ms into the 300ms window)
      await verifyStartedPromise;
      await delay(60);

      clock.advance(1_000n);
      const resetAtMs = clock.now();
      const resetRes = await hub.app.inject({
        method: 'POST',
        url: `/users/${ownerId}/pin`,
        headers: authHeaders(ownerToken1),
        payload: { pin: '917302' },
      });
      expect(resetRes.statusCode).toBe(200);

      // Delayed login MUST be rejected with 401 AUTH_INVALID_CREDENTIALS
      const lateRes = await pLateLogin;
      expect(lateRes.statusCode).toBe(401);
      expect(ApiErrorEnvelopeSchema.parse(lateRes.json()).error.code).toBe(
        'AUTH_INVALID_CREDENTIALS',
      );

      // Old session was revoked AND zero sessions were opened by the late login
      const activeSessions = hub.connection.sqlite
        .prepare<[string], { readonly cnt: bigint }>(
          'SELECT COUNT(*) AS cnt FROM local_sessions WHERE user_id = ? AND revoked_at_ms IS NULL',
        )
        .get(ownerId);
      expect(activeSessions?.cnt).toBe(0n);

      const postResetSessions = hub.connection.sqlite
        .prepare<[string, bigint], { readonly cnt: bigint }>(
          'SELECT COUNT(*) AS cnt FROM local_sessions WHERE user_id = ? AND created_at_ms >= ?',
        )
        .get(ownerId, resetAtMs);
      expect(postResetSessions?.cnt).toBe(0n);

      // Failed-attempt counters (both user & device) MUST NOT have incremented due to this race
      const rawCred = hub.connection.sqlite
        .prepare<
          [string],
          { readonly failed_attempts: bigint; readonly locked_until_ms: bigint | null }
        >('SELECT failed_attempts, locked_until_ms FROM local_pin_credentials WHERE user_id = ?')
        .get(ownerId);
      expect(rawCred?.failed_attempts).toBe(0n);
      expect(rawCred?.locked_until_ms).toBeNull();

      const deviceAuthRows = hub.connection.sqlite
        .prepare<[], { readonly cnt: bigint }>(
          'SELECT COUNT(*) AS cnt FROM local_device_auth_state WHERE failed_attempts > 0',
        )
        .get();
      expect(deviceAuthRows?.cnt).toBe(0n);

      // Previous ownerToken1 stays revoked; old PIN still fails; new PIN succeeds cleanly
      expect(
        (
          await hub.app.inject({
            method: 'GET',
            url: '/auth/me',
            headers: authHeaders(ownerToken1),
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: loopHeaders(),
            payload: { userId: ownerId, pin: '839204' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await hub.app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: loopHeaders(),
            payload: { userId: ownerId, pin: '917302' },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await hub.close();
    }
  }, 30_000);

  it('allows allowlisted app://mezon Electron custom scheme with strict non-credentialed CORS while keeping other origins locked down', async () => {
    await expect(
      createHubServer({
        dbPath: makeDbPath('bad-app-origin.db'),
        allowedOrigins: ['app://mezon/subpath'],
        logLevel: 'silent',
        pinHasher: makeFastTestHasher(),
      }),
    ).rejects.toThrow(/without path/);

    await expect(
      createHubServer({
        dbPath: makeDbPath('bad-file-origin.db'),
        allowedOrigins: ['file://'],
        logLevel: 'silent',
        pinHasher: makeFastTestHasher(),
      }),
    ).rejects.toThrow();

    const hub = await createHubServer({
      dbPath: makeDbPath('electron-origin.db'),
      port: TEST_PORT,
      allowedOrigins: ['app://mezon'],
      logLevel: 'silent',
      pinHasher: makeFastTestHasher(),
    });

    try {
      const allowedGet = await hub.app.inject({
        method: 'GET',
        url: '/health',
        headers: loopHeaders({
          origin: 'app://mezon',
          'sec-fetch-site': 'cross-site',
        }),
      });
      expect(allowedGet.statusCode).toBe(200);
      expect(allowedGet.headers['access-control-allow-origin']).toBe('app://mezon');
      expect(allowedGet.headers['access-control-allow-credentials']).toBeUndefined();
      expect(allowedGet.headers['vary']).toBe('Origin');

      const allowedPreflight = await hub.app.inject({
        method: 'OPTIONS',
        url: '/auth/login',
        headers: loopHeaders({
          origin: 'app://mezon',
          'sec-fetch-site': 'cross-site',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type',
        }),
      });
      expect(allowedPreflight.statusCode).toBe(204);
      expect(allowedPreflight.headers['access-control-allow-origin']).toBe('app://mezon');
      expect(allowedPreflight.headers['access-control-allow-credentials']).toBeUndefined();

      for (const badOrigin of ['app://evil', 'file://', 'https://evil.uz']) {
        const denied = await hub.app.inject({
          method: 'GET',
          url: '/health',
          headers: loopHeaders({ origin: badOrigin, 'sec-fetch-site': 'cross-site' }),
        });
        expect(denied.statusCode).toBe(403);
        expect(denied.headers['access-control-allow-origin']).toBeUndefined();
      }
    } finally {
      await hub.close();
    }
  });
});
