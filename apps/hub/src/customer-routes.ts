import {
  CreateCustomerRequestSchema,
  CreateDebtAdjustmentRequestSchema,
  CreateDebtPaymentRequestSchema,
  CreateOpeningBalanceRequestSchema,
  CustomerIdParamsSchema,
  CustomerLedgerQuerySchema,
  CustomerListQuerySchema,
  UpdateCustomerRequestSchema,
} from '@mezon/contracts';
import type { HubPermission } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HubAuthService } from './auth-service.js';
import type { HubCustomerService } from './customer-service.js';

async function authorize(
  authService: HubAuthService,
  request: FastifyRequest,
  permission: HubPermission,
) {
  const session = await authService.authenticate(request.headers.authorization);
  authService.assertPermission(session, permission);
  return session;
}

export function registerCustomerRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  customerService: HubCustomerService,
): void {
  // Read & search (`customers:read`: owner, manager, cashier)
  app.get('/customers', async (request) => {
    await authorize(authService, request, 'customers:read');
    const query = CustomerListQuerySchema.parse(request.query);
    return customerService.listCustomers(query);
  });

  // Must register static '/customers/overdue' before '/customers/:id'
  app.get('/customers/overdue', async (request) => {
    await authorize(authService, request, 'customers:read');
    const query = CustomerListQuerySchema.parse(request.query);
    return customerService.listOverdueCustomers(query);
  });

  app.get('/customers/:id', async (request) => {
    await authorize(authService, request, 'customers:read');
    const params = CustomerIdParamsSchema.parse(request.params);
    return customerService.getCustomerDetail(params.id);
  });

  app.get('/customers/:id/ledger', async (request) => {
    await authorize(authService, request, 'customers:read');
    const params = CustomerIdParamsSchema.parse(request.params);
    const query = CustomerLedgerQuerySchema.parse(request.query);
    return customerService.listCustomerLedger(params.id, query);
  });

  // Create customer: basic profile (`customers:write`), non-null credit/due policy requires `debt:manage`
  app.post('/customers', async (request, reply) => {
    const session = await authorize(authService, request, 'customers:write');
    const body = CreateCustomerRequestSchema.parse(request.body);
    if (
      (body.creditLimit !== undefined && body.creditLimit !== null) ||
      (body.defaultDueDays !== undefined && body.defaultDueDays !== null)
    ) {
      authService.assertPermission(session, 'debt:manage');
    }
    const res = await customerService.createCustomer(body);
    request.log.info(
      {
        event: 'customer.created',
        organizationId: res.customer.organizationId,
        customerId: res.customer.id,
        actorUserId: session.user.id,
        hasPhone: res.customer.phoneNormalized !== null,
        hasCreditLimit: res.customer.creditLimit !== null,
      },
      'Created customer profile',
    );
    return reply.code(201).send(res);
  });

  // Update customer: basic profile (`customers:write`), credit/due/active policy changes require `debt:manage`
  app.patch('/customers/:id', async (request) => {
    const session = await authorize(authService, request, 'customers:write');
    const params = CustomerIdParamsSchema.parse(request.params);
    const body = UpdateCustomerRequestSchema.parse(request.body);
    if (
      body.creditLimit !== undefined ||
      body.defaultDueDays !== undefined ||
      body.isActive !== undefined
    ) {
      authService.assertPermission(session, 'debt:manage');
    }
    const res = await customerService.updateCustomer(params.id, body);
    request.log.info(
      {
        event: 'customer.updated',
        organizationId: res.customer.organizationId,
        customerId: res.customer.id,
        actorUserId: session.user.id,
        isActive: res.customer.isActive,
      },
      'Updated customer profile',
    );
    return res;
  });

  // Archive (tombstone) customer (`debt:manage`: owner/manager only)
  app.delete('/customers/:id', async (request) => {
    const session = await authorize(authService, request, 'debt:manage');
    const params = CustomerIdParamsSchema.parse(request.params);
    const res = await customerService.archiveCustomer(params.id);
    request.log.info(
      {
        event: 'customer.archived',
        organizationId: session.user.organizationId,
        customerId: res.customerId,
        actorUserId: session.user.id,
        deletedAtMs: res.deletedAtMs,
      },
      'Archived customer profile',
    );
    return res;
  });

  // Opening balance (`debt:manage`: owner/manager only)
  app.post('/customers/:id/opening-balance', async (request, reply) => {
    const session = await authorize(authService, request, 'debt:manage');
    const params = CustomerIdParamsSchema.parse(request.params);
    const body = CreateOpeningBalanceRequestSchema.parse(request.body);
    const res = await customerService.recordOpeningBalance(params.id, session.user.id, body);
    request.log.info(
      {
        event: 'customer_ledger.opening_balance',
        organizationId: res.entry.organizationId,
        storeId: res.entry.storeId,
        customerId: res.customer.id,
        entryId: res.entry.id,
        amountDelta: res.entry.amountDelta,
        balanceAfter: res.entry.balanceAfter,
        actorUserId: session.user.id,
        idempotentReplay: res.idempotentReplay,
      },
      'Recorded customer opening balance',
    );
    return reply.code(res.idempotentReplay ? 200 : 201).send(res);
  });

  // Debt payment (`debt:pay`: owner, manager, cashier)
  app.post('/customers/:id/payments', async (request, reply) => {
    const session = await authorize(authService, request, 'debt:pay');
    const params = CustomerIdParamsSchema.parse(request.params);
    const body = CreateDebtPaymentRequestSchema.parse(request.body);
    const res = await customerService.recordDebtPayment(params.id, session.user.id, body);
    request.log.info(
      {
        event: 'customer_ledger.debt_payment',
        organizationId: res.entry.organizationId,
        storeId: res.entry.storeId,
        customerId: res.customer.id,
        entryId: res.entry.id,
        method: res.entry.paymentMethod,
        amountDelta: res.entry.amountDelta,
        balanceAfter: res.entry.balanceAfter,
        cashMoveId: res.cashMove?.id ?? null,
        actorUserId: session.user.id,
        idempotentReplay: res.idempotentReplay,
      },
      'Recorded customer debt payment',
    );
    return reply.code(res.idempotentReplay ? 200 : 201).send(res);
  });

  // Debt adjustment (`debt:manage`: owner/manager only)
  app.post('/customers/:id/adjustments', async (request, reply) => {
    const session = await authorize(authService, request, 'debt:manage');
    const params = CustomerIdParamsSchema.parse(request.params);
    const body = CreateDebtAdjustmentRequestSchema.parse(request.body);
    const res = await customerService.recordDebtAdjustment(params.id, session.user.id, body);
    request.log.info(
      {
        event: 'customer_ledger.adjustment',
        organizationId: res.entry.organizationId,
        storeId: res.entry.storeId,
        customerId: res.customer.id,
        entryId: res.entry.id,
        amountDelta: res.entry.amountDelta,
        balanceAfter: res.entry.balanceAfter,
        actorUserId: session.user.id,
        idempotentReplay: res.idempotentReplay,
      },
      'Recorded customer debt adjustment',
    );
    return reply.code(res.idempotentReplay ? 200 : 201).send(res);
  });
}
