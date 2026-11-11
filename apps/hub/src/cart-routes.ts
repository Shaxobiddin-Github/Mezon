import {
  AddCartLineRequestSchema,
  CartIdParamsSchema,
  CartLineParamsSchema,
  CompleteSaleRequestSchema,
  CreateCartRequestSchema,
  CreatePromotionRequestSchema,
  ListPromotionsQuerySchema,
  ParkCartRequestSchema,
  PromotionIdParamsSchema,
  SetCartDiscountRequestSchema,
  UpdateCartLineRequestSchema,
  UpdateCartSettingsRequestSchema,
  UpdatePromotionRequestSchema,
} from '@mezon/contracts';
import type { HubPermission } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HubAuthService } from './auth-service.js';
import type { HubCartService } from './cart-service.js';
import type { HubSaleService } from './sale-service.js';

async function authorize(
  authService: HubAuthService,
  request: FastifyRequest,
  permission: HubPermission,
) {
  const session = await authService.authenticate(request.headers.authorization);
  authService.assertPermission(session, permission);
  return session;
}

export function registerCartRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  cartService: HubCartService,
  saleService?: HubSaleService,
): void {
  // --- Cashier Discount Limits & Quick-Sale Defaults (P3) ---

  app.get('/cart-settings', async (request) => {
    await authorize(authService, request, 'cart:write');
    return cartService.getSettings();
  });

  app.put('/cart-settings', async (request) => {
    const session = await authorize(authService, request, 'discounts:config');
    const body = UpdateCartSettingsRequestSchema.parse(request.body);
    const updated = await cartService.updateSettings(body);
    if (updated.unlimitedDiscountEnabled) {
      request.log.warn(
        {
          event: 'discount_policy.unlimited_enabled',
          actorUserId: session.user.id,
          organizationId: session.user.organizationId,
          percentUnlimited: updated.cashierDiscountLimit.percentUnlimited,
          amountUnlimited: updated.cashierDiscountLimit.amountUnlimited,
        },
        'Owner enabled unlimited cashier discount cap',
      );
    }
    return updated;
  });

  // --- Promotions CRUD (`owner`/`manager` write, cashier read) ---

  app.get('/promotions', async (request) => {
    await authorize(authService, request, 'promotions:read');
    const query = ListPromotionsQuerySchema.parse(request.query);
    return cartService.listPromotions(query);
  });

  app.post('/promotions', async (request, reply) => {
    await authorize(authService, request, 'promotions:write');
    const body = CreatePromotionRequestSchema.parse(request.body);
    const res = await cartService.createPromotion(body);
    return reply.code(201).send(res);
  });

  app.patch('/promotions/:id', async (request) => {
    await authorize(authService, request, 'promotions:write');
    const params = PromotionIdParamsSchema.parse(request.params);
    const body = UpdatePromotionRequestSchema.parse(request.body);
    return cartService.updatePromotion(params.id, body);
  });

  app.delete('/promotions/:id', async (request) => {
    await authorize(authService, request, 'promotions:write');
    const params = PromotionIdParamsSchema.parse(request.params);
    return cartService.deletePromotion(params.id);
  });

  // --- Carts & Lines (Cashier accessible) ---

  app.post('/carts', async (request, reply) => {
    const session = await authorize(authService, request, 'cart:write');
    CreateCartRequestSchema.parse(request.body);
    const res = await cartService.openCart(session.user.id);
    return reply.code(201).send(res);
  });

  app.get('/carts', async (request) => {
    await authorize(authService, request, 'cart:write');
    return cartService.listCarts();
  });

  app.get('/carts/:id', async (request) => {
    await authorize(authService, request, 'cart:write');
    const params = CartIdParamsSchema.parse(request.params);
    return cartService.getCart(params.id);
  });

  app.delete('/carts/:id', async (request) => {
    await authorize(authService, request, 'cart:write');
    const params = CartIdParamsSchema.parse(request.params);
    return cartService.deleteCart(params.id);
  });

  app.post('/carts/:id/lines', async (request, reply) => {
    await authorize(authService, request, 'cart:write');
    const params = CartIdParamsSchema.parse(request.params);
    const body = AddCartLineRequestSchema.parse(request.body);
    const res = await cartService.addLine(params.id, body);
    return reply.code(201).send(res);
  });

  app.patch('/carts/:id/lines/:lineId', async (request) => {
    await authorize(authService, request, 'cart:write');
    const params = CartLineParamsSchema.parse(request.params);
    const body = UpdateCartLineRequestSchema.parse(request.body);
    return cartService.updateLine(params.id, params.lineId, body);
  });

  app.delete('/carts/:id/lines/:lineId', async (request) => {
    await authorize(authService, request, 'cart:write');
    const params = CartLineParamsSchema.parse(request.params);
    return cartService.removeLine(params.id, params.lineId);
  });

  app.put('/carts/:id/discount', async (request) => {
    await authorize(authService, request, 'cart:write');
    const params = CartIdParamsSchema.parse(request.params);
    const body = SetCartDiscountRequestSchema.parse(request.body);
    return cartService.setDiscount(params.id, body);
  });

  app.post('/carts/:id/refresh-prices', async (request) => {
    await authorize(authService, request, 'cart:write');
    const params = CartIdParamsSchema.parse(request.params);
    return cartService.refreshPrices(params.id);
  });

  app.post('/carts/:id/park', async (request) => {
    await authorize(authService, request, 'cart:write');
    const params = CartIdParamsSchema.parse(request.params);
    const body = ParkCartRequestSchema.parse(request.body);
    return cartService.parkCart(params.id, body?.label ?? null);
  });

  app.post('/carts/:id/resume', async (request) => {
    await authorize(authService, request, 'cart:write');
    const params = CartIdParamsSchema.parse(request.params);
    return cartService.resumeCart(params.id);
  });

  if (saleService) {
    app.post('/carts/:id/complete', async (request) => {
      const session = await authorize(authService, request, 'cart:write');
      const params = CartIdParamsSchema.parse(request.params);
      const body = CompleteSaleRequestSchema.parse(request.body);
      const res = await saleService.completeSale(params.id, session.user.id, body);
      request.log.info(
        {
          event: 'sale.completed',
          organizationId: res.sale.organizationId,
          storeId: res.sale.storeId,
          saleId: res.sale.id,
          receiptNo: res.sale.receiptNo,
          receiptCode: res.sale.receiptCode,
          cashierUserId: res.sale.cashierUserId,
          completedByUserId: res.sale.completedByUserId,
          customerId: res.sale.customerId,
          creditOverrideUsed: body.creditOverride !== undefined,
          paymentMethods: res.sale.payments.map((p) => p.method),
          totalFinal: res.sale.totalFinal,
          totalPaid: res.sale.totalPaid,
          debtAmount: res.sale.debtAmount,
          changeAmount: res.sale.changeAmount,
          lineCount: res.sale.lines.length,
          warningCount: res.warnings.length,
        },
        'Completed POS sale',
      );
      return res;
    });
  }
}
