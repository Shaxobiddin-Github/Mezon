import {
  ConfirmReceivingLineCostRequestSchema,
  CreateReceivingDraftRequestSchema,
  CreateSupplierAdjustmentRequestSchema,
  CreateSupplierOpeningBalanceRequestSchema,
  CreateSupplierPaymentRequestSchema,
  CreateSupplierRequestSchema,
  CreateSupplierReturnRequestSchema,
  PostReceivingRequestSchema,
  ReceivingIdParamsSchema,
  ReceivingLineParamsSchema,
  ReceivingListQuerySchema,
  SupplierIdParamsSchema,
  SupplierLedgerQuerySchema,
  SupplierListQuerySchema,
  SupplierReturnIdParamsSchema,
  UpdateReceivingDraftRequestSchema,
  UpdateSupplierRequestSchema,
} from '@mezon/contracts';
import type { HubPermission } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HubAuthService } from './auth-service.js';
import type { HubSupplierService } from './supplier-service.js';

async function authorize(
  authService: HubAuthService,
  request: FastifyRequest,
  permission: HubPermission,
) {
  const session = await authService.authenticate(request.headers.authorization);
  authService.assertPermission(session, permission);
  return session;
}

export function registerSupplierRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  supplierService: HubSupplierService,
): void {
  // --- Supplier Directory (`owner` / `manager` only; `cashier` has zero supplier permissions) ---

  app.get('/suppliers', async (request) => {
    await authorize(authService, request, 'suppliers:read');
    const query = SupplierListQuerySchema.parse(request.query);
    return supplierService.listSuppliers(query);
  });

  // Register static '/suppliers/overdue' before '/suppliers/:id'
  app.get('/suppliers/overdue', async (request) => {
    await authorize(authService, request, 'suppliers:read');
    const query = SupplierListQuerySchema.parse(request.query);
    return supplierService.listOverdueSuppliers(query);
  });

  app.get('/suppliers/:id', async (request) => {
    await authorize(authService, request, 'suppliers:read');
    const params = SupplierIdParamsSchema.parse(request.params);
    return supplierService.getSupplierDetail(params.id);
  });

  app.get('/suppliers/:id/ledger', async (request) => {
    await authorize(authService, request, 'suppliers:read');
    const params = SupplierIdParamsSchema.parse(request.params);
    const query = SupplierLedgerQuerySchema.parse(request.query);
    return supplierService.listSupplierLedger(params.id, query);
  });

  app.post('/suppliers', async (request, reply) => {
    const session = await authorize(authService, request, 'suppliers:write');
    const body = CreateSupplierRequestSchema.parse(request.body);
    const res = await supplierService.createSupplier(body);
    request.log.info(
      {
        event: 'supplier.created',
        organizationId: res.supplier.organizationId,
        supplierId: res.supplier.id,
        hasTin: res.supplier.tin !== null,
        hasPhone: res.supplier.phoneNormalized !== null,
        actorUserId: session.user.id,
      },
      'Created supplier profile',
    );
    return reply.code(201).send(res);
  });

  app.patch('/suppliers/:id', async (request) => {
    const session = await authorize(authService, request, 'suppliers:write');
    const params = SupplierIdParamsSchema.parse(request.params);
    const body = UpdateSupplierRequestSchema.parse(request.body);
    const res = await supplierService.updateSupplier(params.id, body);
    request.log.info(
      {
        event: 'supplier.updated',
        organizationId: res.supplier.organizationId,
        supplierId: res.supplier.id,
        isActive: res.supplier.isActive,
        actorUserId: session.user.id,
      },
      'Updated supplier profile',
    );
    return res;
  });

  app.delete('/suppliers/:id', async (request) => {
    const session = await authorize(authService, request, 'supplier_debt:manage');
    const params = SupplierIdParamsSchema.parse(request.params);
    const res = await supplierService.archiveSupplier(params.id);
    request.log.info(
      {
        event: 'supplier.archived',
        organizationId: session.user.organizationId,
        supplierId: res.supplierId,
        deletedAtMs: res.deletedAtMs,
        actorUserId: session.user.id,
      },
      'Archived supplier profile',
    );
    return res;
  });

  // --- Supplier Ledger Mutations ---

  app.post('/suppliers/:id/opening-balance', async (request, reply) => {
    const session = await authorize(authService, request, 'supplier_debt:manage');
    const params = SupplierIdParamsSchema.parse(request.params);
    const body = CreateSupplierOpeningBalanceRequestSchema.parse(request.body);
    const res = await supplierService.recordOpeningBalance(params.id, session.user.id, body);
    request.log.info(
      {
        event: 'supplier_ledger.opening_balance',
        organizationId: res.entry.organizationId,
        storeId: res.entry.storeId,
        supplierId: res.supplier.id,
        entryId: res.entry.id,
        amountDelta: res.entry.amountDelta,
        balanceAfter: res.entry.balanceAfter,
        actorUserId: session.user.id,
        idempotentReplay: res.idempotentReplay,
      },
      'Recorded supplier opening balance',
    );
    return reply.code(res.idempotentReplay ? 200 : 201).send(res);
  });

  app.post('/suppliers/:id/payments', async (request, reply) => {
    const session = await authorize(authService, request, 'supplier_debt:pay');
    const params = SupplierIdParamsSchema.parse(request.params);
    const body = CreateSupplierPaymentRequestSchema.parse(request.body);
    const res = await supplierService.recordPayment(params.id, session.user.id, body);
    request.log.info(
      {
        event: 'supplier_ledger.payment',
        organizationId: res.entry.organizationId,
        storeId: res.entry.storeId,
        supplierId: res.supplier.id,
        entryId: res.entry.id,
        method: res.entry.paymentMethod,
        amountDelta: res.entry.amountDelta,
        balanceAfter: res.entry.balanceAfter,
        cashMoveId: res.cashMove?.id ?? null,
        actorUserId: session.user.id,
        idempotentReplay: res.idempotentReplay,
      },
      'Recorded supplier payment',
    );
    return reply.code(res.idempotentReplay ? 200 : 201).send(res);
  });

  app.post('/suppliers/:id/adjustments', async (request, reply) => {
    const session = await authorize(authService, request, 'supplier_debt:manage');
    const params = SupplierIdParamsSchema.parse(request.params);
    const body = CreateSupplierAdjustmentRequestSchema.parse(request.body);
    const res = await supplierService.recordAdjustment(params.id, session.user.id, body);
    request.log.info(
      {
        event: 'supplier_ledger.adjustment',
        organizationId: res.entry.organizationId,
        storeId: res.entry.storeId,
        supplierId: res.supplier.id,
        entryId: res.entry.id,
        amountDelta: res.entry.amountDelta,
        balanceAfter: res.entry.balanceAfter,
        actorUserId: session.user.id,
        idempotentReplay: res.idempotentReplay,
      },
      'Recorded supplier adjustment',
    );
    return reply.code(res.idempotentReplay ? 200 : 201).send(res);
  });

  // --- Receiving Drafts, Posting, E1 Cost Confirmation & E2 Supplier Returns ---

  app.get('/receivings', async (request) => {
    await authorize(authService, request, 'receiving:read');
    const query = ReceivingListQuerySchema.parse(request.query);
    return supplierService.listReceivings(query);
  });

  app.post('/receiving-drafts', async (request, reply) => {
    const session = await authorize(authService, request, 'receiving:write');
    const body = CreateReceivingDraftRequestSchema.parse(request.body);
    const res = await supplierService.createReceivingDraft(session.user.id, body);
    request.log.info(
      {
        event: 'receiving_draft.created',
        organizationId: res.draft.organizationId,
        storeId: res.draft.storeId,
        draftId: res.draft.id,
        supplierId: res.draft.supplierId,
        lineCount: res.draft.lines.length,
        actorUserId: session.user.id,
      },
      'Created receiving draft',
    );
    return reply.code(201).send(res);
  });

  app.get('/receiving-drafts/:id', async (request) => {
    await authorize(authService, request, 'receiving:read');
    const params = ReceivingIdParamsSchema.parse(request.params);
    return supplierService.getReceivingDraft(params.id);
  });

  app.patch('/receiving-drafts/:id', async (request) => {
    const session = await authorize(authService, request, 'receiving:write');
    const params = ReceivingIdParamsSchema.parse(request.params);
    const body = UpdateReceivingDraftRequestSchema.parse(request.body);
    const res = await supplierService.updateReceivingDraft(params.id, body);
    request.log.info(
      {
        event: 'receiving_draft.updated',
        organizationId: res.draft.organizationId,
        storeId: res.draft.storeId,
        draftId: res.draft.id,
        lineCount: res.draft.lines.length,
        actorUserId: session.user.id,
      },
      'Updated receiving draft',
    );
    return res;
  });

  app.post('/receiving-drafts/:id/cancel', async (request) => {
    const session = await authorize(authService, request, 'receiving:write');
    const params = ReceivingIdParamsSchema.parse(request.params);
    const res = await supplierService.cancelReceivingDraft(params.id);
    request.log.info(
      {
        event: 'receiving_draft.cancelled',
        organizationId: res.draft.organizationId,
        storeId: res.draft.storeId,
        draftId: res.draft.id,
        actorUserId: session.user.id,
      },
      'Cancelled receiving draft',
    );
    return res;
  });

  app.post('/receiving-drafts/:id/post', async (request, reply) => {
    const session = await authorize(authService, request, 'receiving:write');
    const params = ReceivingIdParamsSchema.parse(request.params);
    const body = PostReceivingRequestSchema.parse(request.body);
    const res = await supplierService.postReceiving(params.id, session.user.id, body);
    request.log.info(
      {
        event: 'receiving.posted',
        organizationId: res.receiving.organizationId,
        storeId: res.receiving.storeId,
        receivingId: res.receiving.id,
        receivingCode: res.receiving.receivingCode,
        supplierId: res.supplier.id,
        knownCostTotal: res.receiving.knownCostTotal,
        unknownCostLineCount: res.receiving.unknownCostLineCount,
        actorUserId: session.user.id,
        idempotentReplay: res.idempotentReplay,
      },
      'Posted goods receiving document',
    );
    return reply.code(res.idempotentReplay ? 200 : 201).send(res);
  });

  app.get('/receivings/:id', async (request) => {
    await authorize(authService, request, 'receiving:read');
    const params = ReceivingIdParamsSchema.parse(request.params);
    return supplierService.getReceiving(params.id);
  });

  app.post('/receivings/:id/lines/:lineId/confirm-cost', async (request, reply) => {
    const session = await authorize(authService, request, 'receiving:write');
    const params = ReceivingLineParamsSchema.parse(request.params);
    const body = ConfirmReceivingLineCostRequestSchema.parse(request.body);
    const res = await supplierService.confirmReceivingLineCost(
      params.id,
      params.lineId,
      session.user.id,
      body,
    );
    request.log.info(
      {
        event: 'receiving.cost_confirmed',
        organizationId: res.confirmation.organizationId,
        storeId: res.confirmation.storeId,
        receivingId: res.confirmation.receivingId,
        receivingLineId: res.confirmation.receivingLineId,
        confirmationId: res.confirmation.id,
        confirmedTotalCost: res.confirmation.confirmedTotalCost,
        actorUserId: session.user.id,
        idempotentReplay: res.idempotentReplay,
      },
      'Confirmed receiving line cost',
    );
    return reply.code(res.idempotentReplay ? 200 : 201).send(res);
  });

  app.post('/receivings/:id/returns', async (request, reply) => {
    const session = await authorize(authService, request, 'receiving:write');
    const params = ReceivingIdParamsSchema.parse(request.params);
    const body = CreateSupplierReturnRequestSchema.parse(request.body);
    const res = await supplierService.createSupplierReturn(params.id, session.user.id, body);
    request.log.info(
      {
        event: 'supplier_return.created',
        organizationId: res.supplierReturn.organizationId,
        storeId: res.supplierReturn.storeId,
        supplierReturnId: res.supplierReturn.id,
        returnCode: res.supplierReturn.returnCode,
        receivingId: res.supplierReturn.receivingId,
        totalReturnCost: res.supplierReturn.totalReturnCost,
        actorUserId: session.user.id,
        idempotentReplay: res.idempotentReplay,
      },
      'Created return-to-supplier document',
    );
    return reply.code(res.idempotentReplay ? 200 : 201).send(res);
  });

  app.get('/receivings/:id/returns', async (request) => {
    await authorize(authService, request, 'receiving:read');
    const params = ReceivingIdParamsSchema.parse(request.params);
    return supplierService.listReturnsForReceiving(params.id);
  });

  app.get('/supplier-returns/:id', async (request) => {
    await authorize(authService, request, 'receiving:read');
    const params = SupplierReturnIdParamsSchema.parse(request.params);
    return supplierService.getSupplierReturn(params.id);
  });
}
