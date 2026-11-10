import {
  CreateReturnRequestSchema,
  ReturnIdParamsSchema,
  SaleIdParamsSchema,
  SalesLinesReportQuerySchema,
  VoidSaleRequestSchema,
} from '@mezon/contracts';
import type { HubPermission } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HubAuthService } from './auth-service.js';
import type { HubReturnService } from './return-service.js';

async function authorize(
  authService: HubAuthService,
  request: FastifyRequest,
  permission: HubPermission,
) {
  const session = await authService.authenticate(request.headers.authorization);
  authService.assertPermission(session, permission);
  return session;
}

export function registerReturnRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  returnService: HubReturnService,
): void {
  app.post('/sales/:id/void', async (request) => {
    const session = await authService.authenticate(request.headers.authorization);
    const params = SaleIdParamsSchema.parse(request.params);
    const body = VoidSaleRequestSchema.parse(request.body);
    const { response, overrideApprovedByUserId } = await returnService.voidSale(
      params.id,
      session,
      body,
    );

    request.log.info(
      {
        event: 'sale.voided',
        organizationId: response.sale.organizationId,
        storeId: response.sale.storeId,
        saleId: response.sale.id,
        receiptNo: response.sale.receiptNo,
        receiptCode: response.sale.receiptCode,
        actorUserId: session.user.id,
        overrideApprovedByUserId,
        totalFinal: response.sale.totalFinal,
        cashRefundAmount: response.cashRefundAmount,
        reason: response.sale.voidReason,
        idempotentReplay: response.idempotentReplay,
      },
      'Voided POS sale',
    );
    return response;
  });

  app.post('/sales/:id/returns', async (request, reply) => {
    const session = await authService.authenticate(request.headers.authorization);
    const params = SaleIdParamsSchema.parse(request.params);
    const body = CreateReturnRequestSchema.parse(request.body);
    const { response, overrideApprovedByUserId } = await returnService.createReturn(
      params.id,
      session,
      body,
    );

    request.log.info(
      {
        event: 'return.created',
        organizationId: response.returnDoc.organizationId,
        storeId: response.returnDoc.storeId,
        saleId: response.returnDoc.saleId,
        returnId: response.returnDoc.id,
        returnNo: response.returnDoc.returnNo,
        returnCode: response.returnDoc.returnCode,
        actorUserId: session.user.id,
        overrideApprovedByUserId,
        totalRefund: response.returnDoc.totalRefund,
        cashRefundAmount: response.returnDoc.cashRefundAmount,
        nonCashRefundAmount: response.returnDoc.nonCashRefundAmount,
        paymentMethods: response.returnDoc.payments.map((p) => p.method),
        reason: response.returnDoc.reason,
        lineCount: response.returnDoc.lines.length,
        idempotentReplay: response.idempotentReplay,
      },
      'Created POS return document',
    );

    return reply.code(response.idempotentReplay ? 200 : 201).send(response);
  });

  app.get('/sales/:id/returns', async (request) => {
    await authorize(authService, request, 'cart:write');
    const params = SaleIdParamsSchema.parse(request.params);
    return returnService.listSaleReturns(params.id);
  });

  app.get('/returns/:id', async (request) => {
    await authorize(authService, request, 'cart:write');
    const params = ReturnIdParamsSchema.parse(request.params);
    return returnService.getReturnById(params.id);
  });

  app.get('/reports/sales-lines/summary', async (request) => {
    await authorize(authService, request, 'reports:profit');
    const query = SalesLinesReportQuerySchema.parse(request.query);
    return returnService.getSalesLinesReportSummary(query);
  });
}
