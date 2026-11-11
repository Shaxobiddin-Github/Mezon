import {
  CancelOrderRequestSchema,
  ConfirmOrderRequestSchema,
  CreateOrderRequestSchema,
  DeliverOrderRequestSchema,
  ListOrdersQuerySchema,
  MarkOrderReadyRequestSchema,
  OrderIdParamsSchema,
  RecordOrderAdvanceRequestSchema,
  RefundOrderAdvanceRequestSchema,
} from '@mezon/contracts';
import type { HubPermission } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HubAuthService } from './auth-service.js';
import type { HubOrderService } from './order-service.js';

async function authorize(
  authService: HubAuthService,
  request: FastifyRequest,
  permission: HubPermission,
) {
  const session = await authService.authenticate(request.headers.authorization);
  authService.assertPermission(session, permission);
  return session;
}

export function registerOrderRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  orderService: HubOrderService,
): void {
  // Static routes MUST be registered before /orders/:id
  app.get('/orders/open-advances', async (request) => {
    await authorize(authService, request, 'orders:read');
    return orderService.getOpenAdvancesTotal();
  });

  app.get('/orders', async (request) => {
    await authorize(authService, request, 'orders:read');
    const query = ListOrdersQuerySchema.parse(request.query);
    return orderService.listOrders(query);
  });

  app.post('/orders', async (request, reply) => {
    const session = await authorize(authService, request, 'orders:write');
    const body = CreateOrderRequestSchema.parse(request.body);
    const { response, overrideApprovedByUserId } = await orderService.createOrder(
      session.user.id,
      body,
    );

    request.log.info(
      {
        event: 'order.created',
        organizationId: response.order.organizationId,
        storeId: response.order.storeId,
        orderId: response.order.id,
        orderNo: response.order.orderNo,
        orderCode: response.order.orderCode,
        status: response.order.status,
        totalAmount: response.order.totalAmount,
        actorUserId: session.user.id,
        overrideApprovedByUserId,
        lineCount: response.order.lines.length,
        idempotentReplay: response.idempotentReplay,
      },
      'Created customer order',
    );

    return reply.code(response.idempotentReplay ? 200 : 201).send(response);
  });

  app.get('/orders/:id', async (request) => {
    await authorize(authService, request, 'orders:read');
    const params = OrderIdParamsSchema.parse(request.params);
    return orderService.getOrder(params.id);
  });

  app.post('/orders/:id/confirm', async (request) => {
    const session = await authorize(authService, request, 'orders:write');
    const params = OrderIdParamsSchema.parse(request.params);
    const body = ConfirmOrderRequestSchema.parse(request.body);
    const response = await orderService.confirmOrder(params.id, session.user.id, body);

    request.log.info(
      {
        event: 'order.confirmed',
        organizationId: response.order.organizationId,
        storeId: response.order.storeId,
        orderId: response.order.id,
        orderCode: response.order.orderCode,
        status: response.order.status,
        actorUserId: session.user.id,
        idempotentReplay: response.idempotentReplay,
      },
      'Confirmed customer order',
    );

    return response;
  });

  app.post('/orders/:id/ready', async (request) => {
    const session = await authorize(authService, request, 'orders:write');
    const params = OrderIdParamsSchema.parse(request.params);
    const body = MarkOrderReadyRequestSchema.parse(request.body);
    const response = await orderService.markOrderReady(params.id, session.user.id, body);

    request.log.info(
      {
        event: 'order.ready',
        organizationId: response.order.organizationId,
        storeId: response.order.storeId,
        orderId: response.order.id,
        orderCode: response.order.orderCode,
        status: response.order.status,
        actorUserId: session.user.id,
        idempotentReplay: response.idempotentReplay,
      },
      'Marked customer order ready',
    );

    return response;
  });

  app.post('/orders/:id/advances', async (request, reply) => {
    const session = await authorize(authService, request, 'orders:write');
    const params = OrderIdParamsSchema.parse(request.params);
    const body = RecordOrderAdvanceRequestSchema.parse(request.body);
    const response = await orderService.recordOrderAdvance(params.id, session.user.id, body);

    request.log.info(
      {
        event: 'order.advance_recorded',
        organizationId: response.order.organizationId,
        storeId: response.order.storeId,
        orderId: response.order.id,
        orderCode: response.order.orderCode,
        status: response.order.status,
        netAdvance: response.order.netAdvance,
        remainingToPay: response.order.remainingToPay,
        paymentMethods: body.payments.map((p) => p.method),
        actorUserId: session.user.id,
        idempotentReplay: response.idempotentReplay,
      },
      'Recorded customer order advance',
    );

    return reply.code(response.idempotentReplay ? 200 : 201).send(response);
  });

  app.post('/orders/:id/advances/refund', async (request) => {
    const session = await authorize(authService, request, 'orders:write');
    const params = OrderIdParamsSchema.parse(request.params);
    const body = RefundOrderAdvanceRequestSchema.parse(request.body);
    const { response, overrideApprovedByUserId } = await orderService.refundOrderAdvance(
      params.id,
      session,
      body,
    );

    request.log.info(
      {
        event: 'order.advance_refunded',
        organizationId: response.order.organizationId,
        storeId: response.order.storeId,
        orderId: response.order.id,
        orderCode: response.order.orderCode,
        netAdvance: response.order.netAdvance,
        refundMethods: body.refunds.map((r) => r.method),
        actorUserId: session.user.id,
        overrideApprovedByUserId,
        idempotentReplay: response.idempotentReplay,
      },
      'Refunded customer order advance',
    );

    return response;
  });

  app.post('/orders/:id/deliver', async (request) => {
    const session = await authorize(authService, request, 'orders:write');
    const params = OrderIdParamsSchema.parse(request.params);
    const body = DeliverOrderRequestSchema.parse(request.body);
    const response = await orderService.deliverOrder(params.id, session.user.id, body);

    request.log.info(
      {
        event: 'order.delivered',
        organizationId: response.order.organizationId,
        storeId: response.order.storeId,
        orderId: response.order.id,
        orderCode: response.order.orderCode,
        deliveredSaleId: response.sale.id,
        receiptCode: response.sale.receiptCode,
        totalFinal: response.sale.totalFinal,
        debtAmount: response.sale.debtAmount,
        actorUserId: session.user.id,
        idempotentReplay: response.idempotentReplay,
      },
      'Delivered customer order into finalized sale',
    );

    return response;
  });

  app.post('/orders/:id/cancel', async (request) => {
    const session = await authorize(authService, request, 'orders:write');
    const params = OrderIdParamsSchema.parse(request.params);
    const body = CancelOrderRequestSchema.parse(request.body);
    const { response, overrideApprovedByUserId } = await orderService.cancelOrder(
      params.id,
      session,
      body,
    );

    request.log.info(
      {
        event: 'order.cancelled',
        organizationId: response.order.organizationId,
        storeId: response.order.storeId,
        orderId: response.order.id,
        orderCode: response.order.orderCode,
        status: response.order.status,
        actorUserId: session.user.id,
        overrideApprovedByUserId,
        idempotentReplay: response.idempotentReplay,
      },
      'Cancelled customer order',
    );

    return response;
  });
}
