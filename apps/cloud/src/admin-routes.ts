import { createHash, randomBytes } from 'node:crypto';
import {
  AdminCustomersQuerySchema,
  AdminProductsQuerySchema,
  AdminReceiptsQuerySchema,
  type CloudLoginRequestDto,
  CloudLoginRequestSchema,
  DailySalesReportQuerySchema,
} from '@mezon/contracts';
import { AdminReadStore, type CloudAuthStore, type CloudPgConnection } from '@mezon/db-cloud';
import {
  DomainError,
  type IdGenerator,
  MonotonicUuidV7Generator,
  type UnixMs,
  type UuidV7,
  moneyToTiyin,
  parseUuidV7,
  quantityToMilli,
  unixMsFromBigInt,
} from '@mezon/domain';
import * as argon2 from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CloudConfig } from './config.js';
import type { CloudJwtPayload, CloudJwtService } from './jwt.js';

export interface AdminRoutesOptions {
  readonly config: CloudConfig;
  readonly conn: CloudPgConnection<Record<string, unknown>>;
  readonly jwtService: CloudJwtService;
  readonly authStore: CloudAuthStore;
  readonly adminStore: AdminReadStore;
  readonly idGen?: { nextId(): UuidV7 };
  readonly clock?: { nowMs(): UnixMs };
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_COOKIE_NAME = 'mezon_admin_refresh';

function parseCookie(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      result[key] = decodeURIComponent(val);
    }
  }
  return result;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  options: AdminRoutesOptions,
): Promise<void> {
  await Promise.resolve();
  const { config, jwtService, authStore, adminStore } = options;
  const defaultIdGen: IdGenerator = new MonotonicUuidV7Generator({
    clock: { now: () => unixMsFromBigInt(BigInt(Date.now())) },
    random: { nextBytes: (n: number) => randomBytes(n) },
  });
  const idGen = options.idGen ?? defaultIdGen;
  const clock = options.clock ?? { nowMs: () => unixMsFromBigInt(BigInt(Date.now())) };

  // Helper to set HttpOnly refresh cookie with Strict SameSite and Path=/api/v1/admin/auth (A3)
  const setRefreshCookie = (reply: FastifyReply, refreshToken: string) => {
    const isProd = config.nodeEnv === 'production';
    const cookie = `${REFRESH_COOKIE_NAME}=${encodeURIComponent(refreshToken)}; Path=/api/v1/admin/auth; HttpOnly; SameSite=Strict; Max-Age=2592000${isProd ? '; Secure' : ''}`;
    void reply.header('Set-Cookie', cookie);
  };

  const clearRefreshCookie = (reply: FastifyReply) => {
    const isProd = config.nodeEnv === 'production';
    const cookie = `${REFRESH_COOKIE_NAME}=; Path=/api/v1/admin/auth; HttpOnly; SameSite=Strict; Max-Age=0${isProd ? '; Secure' : ''}`;
    void reply.header('Set-Cookie', cookie);
  };

  // 1. POST /api/v1/admin/auth/login
  app.post<{ Body: CloudLoginRequestDto }>(
    '/api/v1/admin/auth/login',
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

      const lookup = await authStore.lookupLogin(login);
      if (!lookup) {
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

      // Cashiers cannot use the Admin portal
      if (lookup.userRole !== 'owner' && lookup.userRole !== 'manager') {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Cashier accounts cannot access the admin cabinet',
        });
      }

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

      if (lookup.failedLoginAttempts > 0 || lookup.lockedUntilMs !== null) {
        await authStore.resetLoginFailure({
          organizationId: lookup.organizationId,
          userId: lookup.userId,
          nowMs,
        });
      }

      const accessToken = await jwtService.signAccessToken({
        sub: lookup.userId,
        org: lookup.organizationId,
        role: lookup.userRole,
        name: lookup.userName,
      });

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

      setRefreshCookie(reply, refreshToken);

      return reply.code(200).send({
        accessToken,
        user: {
          id: lookup.userId,
          organizationId: lookup.organizationId,
          role: lookup.userRole,
          name: lookup.userName,
        },
      });
    },
  );

  // 2. POST /api/v1/admin/auth/refresh (A3 Cookie + CSRF protection: Origin + X-Mezon-Admin)
  /**
   * A3 CSRF guard for every cookie-authenticated admin route: a custom header that a cross-site
   * form cannot set, plus an Origin allowlist when the browser sends Origin.
   * Returns true when the request was rejected (reply already sent).
   */
  const rejectAdminCsrf = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.headers['x-mezon-admin'] !== '1') {
      void reply.code(400).send({
        error: 'Bad Request',
        message: 'Missing or invalid X-Mezon-Admin security header',
      });
      return true;
    }
    const origin = req.headers.origin;
    if (origin && !config.corsOrigins.includes('*') && !config.corsOrigins.includes(origin)) {
      void reply.code(403).send({ error: 'Forbidden', message: 'Cross-origin request rejected' });
      return true;
    }
    return false;
  };

  app.post('/api/v1/admin/auth/refresh', async (req, reply) => {
    if (rejectAdminCsrf(req, reply)) return reply;

    // Read refreshToken from HttpOnly cookie
    const cookies = parseCookie(req.headers.cookie);
    const refreshToken = cookies[REFRESH_COOKIE_NAME];
    if (!refreshToken) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Missing admin refresh cookie',
      });
    }

    const firstDot = refreshToken.indexOf('.');
    if (firstDot === -1) {
      clearRefreshCookie(reply);
      return reply.code(401).send({ error: 'Unauthorized', message: 'Malformed refresh token' });
    }

    let organizationId: UuidV7;
    try {
      organizationId = parseUuidV7(refreshToken.slice(0, firstDot));
    } catch {
      clearRefreshCookie(reply);
      return reply.code(401).send({ error: 'Unauthorized', message: 'Malformed refresh token' });
    }

    const rawSecret = refreshToken.slice(firstDot + 1);
    const oldHash = createHash('sha256').update(rawSecret).digest('hex');
    const nowMs = clock.nowMs();
    const nextTokenId = idGen.nextId();
    const nextRawSecret = randomBytes(32).toString('base64url');
    const nextHash = createHash('sha256').update(nextRawSecret).digest('hex');
    const nextExpiresAtMs = unixMsFromBigInt(BigInt(nowMs) + BigInt(THIRTY_DAYS_MS));

    try {
      const rotated = await authStore.rotateRefreshToken({
        organizationId,
        oldTokenHash: oldHash,
        newTokenId: nextTokenId,
        newTokenHash: nextHash,
        newExpiresAtMs: nextExpiresAtMs,
        nowMs,
        allowedRoles: ['owner', 'manager'],
      });

      const nextRefreshToken = `${organizationId}.${nextRawSecret}`;

      // S1: claims are re-read from the user row on every refresh.
      const newAccessToken = await jwtService.signAccessToken({
        sub: rotated.userId,
        org: organizationId,
        role: rotated.role,
        name: rotated.userName,
      });

      setRefreshCookie(reply, nextRefreshToken);

      return reply.code(200).send({
        accessToken: newAccessToken,
      });
    } catch (err) {
      clearRefreshCookie(reply);
      if (err instanceof DomainError && err.code === 'AUTH_UNAUTHORIZED') {
        return reply.code(401).send({ error: 'Unauthorized', message: err.message });
      }
      if (err instanceof DomainError && err.code === 'AUTH_FORBIDDEN') {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Cashier accounts cannot access the admin cabinet',
        });
      }
      throw err;
    }
  });

  // 3. POST /api/v1/admin/auth/logout
  app.post('/api/v1/admin/auth/logout', async (req, reply) => {
    if (rejectAdminCsrf(req, reply)) return reply;
    const cookies = parseCookie(req.headers.cookie);
    const refreshToken = cookies[REFRESH_COOKIE_NAME];
    if (refreshToken) {
      const firstDot = refreshToken.indexOf('.');
      if (firstDot !== -1) {
        try {
          const organizationId = parseUuidV7(refreshToken.slice(0, firstDot));
          const rawSecret = refreshToken.slice(firstDot + 1);
          const hash = createHash('sha256').update(rawSecret).digest('hex');
          await authStore.revokeRefreshToken({
            organizationId,
            tokenHash: hash,
            nowMs: clock.nowMs(),
          });
        } catch {
          // Ignore parse errors on logout
        }
      }
    }

    clearRefreshCookie(reply);
    return reply.code(200).send({ status: 'ok' });
  });

  // RBAC & Tenant Context Hook for /api/v1/admin/* (except /auth/*)
  const requireAdminAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Missing Bearer token' });
    }

    const token = authHeader.slice(7).trim();
    let payload: CloudJwtPayload;
    try {
      payload = await jwtService.verifyAccessToken(token);
    } catch {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
    }

    // Role check: cashier is strictly forbidden from admin cabinet (A4)
    if (payload.role !== 'owner' && payload.role !== 'manager') {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Cashier accounts cannot access the admin cabinet',
      });
    }

    req.user = payload;
  };

  // 4. GET /api/v1/admin/dashboard
  app.get('/api/v1/admin/dashboard', { preHandler: [requireAdminAuth] }, async (req, reply) => {
    const user = req.user!;
    const query = req.query as { storeId?: string; tz?: string };
    const storeId = query.storeId ? parseUuidV7(query.storeId) : undefined;

    const metrics = await adminStore.getDashboard({
      organizationId: user.org,
      storeId,
      tz: query.tz,
      includeProfit: true,
      nowMs: clock.nowMs(),
    });

    return reply.code(200).send({
      todayDate: metrics.todayDate,
      grossSales: moneyToTiyin(metrics.grossSales).toString(),
      returnsTotal: moneyToTiyin(metrics.returnsTotal).toString(),
      netSales: moneyToTiyin(metrics.netSales).toString(),
      receiptsCount: metrics.receiptsCount,
      avgReceipt: moneyToTiyin(metrics.avgReceipt).toString(),
      grossProfit: metrics.grossProfit ? moneyToTiyin(metrics.grossProfit).toString() : undefined,
      marginBp: metrics.marginBp,
      stores: metrics.stores.map((s) => ({
        storeId: s.storeId,
        storeName: s.storeName,
        lastEventAtMs: s.lastEventAtMs !== null ? s.lastEventAtMs.toString() : null,
        isStale: s.isStale,
      })),
    });
  });

  // 5. GET /api/v1/admin/reports/daily (A1 Report parity)
  app.get('/api/v1/admin/reports/daily', { preHandler: [requireAdminAuth] }, async (req, reply) => {
    const user = req.user!;
    const parseResult = DailySalesReportQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        details: parseResult.error.flatten(),
      });
    }
    const q = parseResult.data;
    const rawQuery = req.query as { storeId?: string; tz?: string };
    const storeId = rawQuery.storeId ? parseUuidV7(rawQuery.storeId) : undefined;

    const rep = await adminStore.getDailySalesReport({
      organizationId: user.org,
      storeId,
      fromDate: q.fromDate,
      toDate: q.toDate,
      limit: q.limit,
      tz: rawQuery.tz,
      includeCostAndProfit: true,
    });

    return reply.code(200).send({
      days: rep.days.map((d) => ({
        date: d.date,
        salesCount: d.salesCount,
        returnsCount: d.returnsCount,
        grossSales: moneyToTiyin(d.grossSales).toString(),
        returnsTotal: moneyToTiyin(d.returnsTotal).toString(),
        netSales: moneyToTiyin(d.netSales).toString(),
        vatTotal: moneyToTiyin(d.vatTotal).toString(),
        totalQtyMilli: quantityToMilli(d.totalQty).toString(),
        cashSales: moneyToTiyin(d.cashSales).toString(),
        nonCashSales: moneyToTiyin(d.nonCashSales).toString(),
        costValue: d.costValue ? moneyToTiyin(d.costValue).toString() : undefined,
        grossProfit: d.grossProfit ? moneyToTiyin(d.grossProfit).toString() : undefined,
      })),
      totalSalesCount: rep.totalSalesCount,
      totalReturnsCount: rep.totalReturnsCount,
      totalGrossSales: moneyToTiyin(rep.totalGrossSales).toString(),
      totalReturns: moneyToTiyin(rep.totalReturns).toString(),
      totalNetSales: moneyToTiyin(rep.totalNetSales).toString(),
      totalVat: moneyToTiyin(rep.totalVat).toString(),
      totalCashSales: moneyToTiyin(rep.totalCashSales).toString(),
      totalNonCashSales: moneyToTiyin(rep.totalNonCashSales).toString(),
      totalCostValue: rep.totalCostValue ? moneyToTiyin(rep.totalCostValue).toString() : undefined,
      totalGrossProfit: rep.totalGrossProfit
        ? moneyToTiyin(rep.totalGrossProfit).toString()
        : undefined,
    });
  });

  // 6. GET /api/v1/admin/receipts (A5 Keyset pagination)
  app.get('/api/v1/admin/receipts', { preHandler: [requireAdminAuth] }, async (req, reply) => {
    const user = req.user!;
    const parseResult = AdminReceiptsQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        details: parseResult.error.flatten(),
      });
    }
    const q = parseResult.data;

    const res = await adminStore.getReceiptsList(user.org, {
      storeId: q.storeId ? parseUuidV7(q.storeId) : undefined,
      status: q.status === 'voided' ? 'voided' : q.status === 'completed' ? 'completed' : undefined,
      cursor: q.cursor,
      limit: q.limit,
    });

    return reply.code(200).send({
      items: res.items.map((i) => ({
        id: i.id,
        receiptNumber: i.receiptNumber,
        storeId: i.storeId,
        storeName: i.storeName,
        cashierName: i.cashierName,
        totalTiyin: moneyToTiyin(i.total).toString(),
        status: i.status,
        paymentMethods: [...i.paymentMethods],
        createdAtMs: i.createdAtMs.toString(),
        voidedAtMs: i.voidedAtMs !== null ? i.voidedAtMs.toString() : null,
      })),
      nextCursor: res.nextCursor,
    });
  });

  // 7. GET /api/v1/admin/receipts/:id
  app.get('/api/v1/admin/receipts/:id', { preHandler: [requireAdminAuth] }, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    let receiptId: UuidV7;
    try {
      receiptId = parseUuidV7(id);
    } catch {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid receipt UUID' });
    }

    const receipt = await adminStore.getReceiptDetail(user.org, receiptId);
    if (!receipt) {
      return reply.code(404).send({ error: 'Not Found', message: 'Receipt not found' });
    }

    return reply.code(200).send({
      id: receipt.id,
      receiptNumber: receipt.receiptNumber,
      storeId: receipt.storeId,
      storeName: receipt.storeName,
      cashierName: receipt.cashierName,
      customerName: receipt.customerName,
      status: receipt.status,
      grossTotalTiyin: moneyToTiyin(receipt.grossTotal).toString(),
      discountTotalTiyin: moneyToTiyin(receipt.discountTotal).toString(),
      netTotalTiyin: moneyToTiyin(receipt.netTotal).toString(),
      vatTotalTiyin: moneyToTiyin(receipt.vatTotal).toString(),
      createdAtMs: receipt.createdAtMs.toString(),
      voidedAtMs: receipt.voidedAtMs !== null ? receipt.voidedAtMs.toString() : null,
      voidReason: receipt.voidReason,
      lines: receipt.lines.map((l) => ({
        id: l.id,
        productId: l.productId,
        productName: l.productName,
        sku: l.sku,
        barcode: l.barcode,
        unit: l.unit,
        qtyMilli: quantityToMilli(l.qty).toString(),
        unitPriceTiyin: moneyToTiyin(l.unitPrice).toString(),
        totalTiyin: moneyToTiyin(l.total).toString(),
        vatPercent: l.vatPercent,
        vatTiyin: moneyToTiyin(l.vatAmount).toString(),
        discountTiyin: moneyToTiyin(l.discountAmount).toString(),
        mxikCode: l.mxikCode,
      })),
      payments: receipt.payments.map((p) => ({
        id: p.id,
        method: p.method,
        amountTiyin: moneyToTiyin(p.amount).toString(),
        createdAtMs: p.createdAtMs.toString(),
      })),
    });
  });

  // 8. GET /api/v1/admin/customers (A6 Masked phone)
  app.get('/api/v1/admin/customers', { preHandler: [requireAdminAuth] }, async (req, reply) => {
    const user = req.user!;
    const parseResult = AdminCustomersQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        details: parseResult.error.flatten(),
      });
    }
    const q = parseResult.data;

    const res = await adminStore.getCustomersList(user.org, {
      search: q.search,
      hasDebtOnly: q.hasDebtOnly,
      cursor: q.cursor,
      limit: q.limit,
    });

    return reply.code(200).send({
      items: res.items.map((c) => ({
        id: c.id,
        fullName: c.fullName,
        maskedPhone: c.maskedPhone,
        balanceTiyin: moneyToTiyin(c.balance).toString(),
        overdueAmountTiyin: moneyToTiyin(c.overdueAmount).toString(),
        createdAtMs: c.createdAtMs.toString(),
      })),
      nextCursor: res.nextCursor,
    });
  });

  // 9. GET /api/v1/admin/customers/:id (A6 Unmasked phone for manager/owner)
  app.get('/api/v1/admin/customers/:id', { preHandler: [requireAdminAuth] }, async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };
    let customerId: UuidV7;
    try {
      customerId = parseUuidV7(id);
    } catch {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid customer UUID' });
    }

    const isPrivileged = user.role === 'owner' || user.role === 'manager';
    const cust = await adminStore.getCustomerDetail({
      organizationId: user.org,
      customerId,
      isPrivilegedRole: isPrivileged,
    });

    if (!cust) {
      return reply.code(404).send({ error: 'Not Found', message: 'Customer not found' });
    }

    return reply.code(200).send({
      id: cust.id,
      fullName: cust.fullName,
      phone: cust.phone,
      balanceTiyin: moneyToTiyin(cust.balance).toString(),
      overdueAmountTiyin: moneyToTiyin(cust.overdueAmount).toString(),
      earliestOverdueDueAtMs:
        cust.earliestOverdueDueAtMs !== null ? cust.earliestOverdueDueAtMs.toString() : null,
      notes: cust.notes,
      createdAtMs: cust.createdAtMs.toString(),
      ledger: cust.ledger.map((l) => ({
        id: l.id,
        entryType: l.entryType,
        amountTiyin: moneyToTiyin(l.amount).toString(),
        balanceAfterTiyin: moneyToTiyin(l.balanceAfter).toString(),
        sourceType: l.sourceType,
        sourceId: l.sourceId,
        reason: l.reason,
        createdAtMs: l.createdAtMs.toString(),
      })),
    });
  });

  // 10. GET /api/v1/admin/products
  app.get('/api/v1/admin/products', { preHandler: [requireAdminAuth] }, async (req, reply) => {
    const user = req.user!;
    const parseResult = AdminProductsQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        details: parseResult.error.flatten(),
      });
    }
    const q = parseResult.data;

    const res = await adminStore.getProductsList(user.org, {
      search: q.search,
      categoryId: q.categoryId ? parseUuidV7(q.categoryId) : undefined,
      cursor: q.cursor,
      limit: q.limit,
    });

    return reply.code(200).send({
      items: res.items.map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        barcode: p.barcode,
        unit: p.unit,
        priceTiyin: moneyToTiyin(p.price).toString(),
        vatPercent: p.vatPercent,
        currentStockMilli: quantityToMilli(p.currentStock).toString(),
        minStockMilli: quantityToMilli(p.minStock).toString(),
      })),
      nextCursor: res.nextCursor,
    });
  });

  // 11. GET /api/v1/admin/inventory/low-stock
  app.get(
    '/api/v1/admin/inventory/low-stock',
    { preHandler: [requireAdminAuth] },
    async (req, reply) => {
      const user = req.user!;
      const query = req.query as { storeId?: string };
      const storeId = query.storeId ? parseUuidV7(query.storeId) : undefined;

      const items = await adminStore.getLowStockItems(user.org, storeId);

      return reply.code(200).send({
        items: items.map((i) => ({
          productId: i.productId,
          name: i.name,
          sku: i.sku,
          barcode: i.barcode,
          unit: i.unit,
          currentStockMilli: quantityToMilli(i.currentStock).toString(),
          minStockMilli: quantityToMilli(i.minStock).toString(),
          deficitMilli: quantityToMilli(i.deficit).toString(),
        })),
      });
    },
  );

  // 12. GET /api/v1/admin/conflicts
  app.get('/api/v1/admin/conflicts', { preHandler: [requireAdminAuth] }, async (req, reply) => {
    const user = req.user!;
    const items = await adminStore.getConflictsList(user.org);

    return reply.code(200).send({
      items: items.map((c) => ({
        eventId: c.eventId,
        storeId: c.storeId,
        deviceId: c.deviceId,
        type: c.type,
        entity: c.entity,
        entityId: c.entityId,
        reason: c.reason,
        attempts: c.attempts,
        parkedAtMs: c.parkedAtMs.toString(),
      })),
    });
  });

  // 13. GET /api/v1/admin/stores/freshness
  app.get(
    '/api/v1/admin/stores/freshness',
    { preHandler: [requireAdminAuth] },
    async (req, reply) => {
      const user = req.user!;
      const items = await adminStore.getStoreFreshness(user.org);

      return reply.code(200).send(
        items.map((s) => ({
          storeId: s.storeId,
          storeName: s.storeName,
          lastEventAtMs: s.lastEventAtMs !== null ? s.lastEventAtMs.toString() : null,
          isStale: s.isStale,
        })),
      );
    },
  );
}
