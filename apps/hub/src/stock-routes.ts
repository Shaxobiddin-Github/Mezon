import {
  CreateInboundStockMoveRequestSchema,
  CreateOutboundStockMoveRequestSchema,
  InventoryCountIdParamsSchema,
  ListBatchesQuerySchema,
  ListStockMovesQuerySchema,
  RecordInventoryCountLinesRequestSchema,
  StartInventoryCountRequestSchema,
  UpdateNegativeStockPolicyRequestSchema,
} from '@mezon/contracts';
import type { HubPermission } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HubAuthService } from './auth-service.js';
import type { HubStockService } from './stock-service.js';

async function authorize(
  authService: HubAuthService,
  request: FastifyRequest,
  permission: HubPermission,
) {
  const session = await authService.authenticate(request.headers.authorization);
  authService.assertPermission(session, permission);
  return session;
}

export function registerStockRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  stockService: HubStockService,
): void {
  // Cashier-accessible quantity-only balance view (ZERO cost/valuation/variance fields)
  app.get('/stock/balances', async (request) => {
    await authorize(authService, request, 'stock:read');
    return stockService.listCashierBalances();
  });

  // Owner/Manager-only cost & batch & ledger & conflict endpoints
  app.get('/stock/valuation', async (request) => {
    await authorize(authService, request, 'stock:write');
    return stockService.listValuations();
  });

  app.get('/stock/batches', async (request) => {
    await authorize(authService, request, 'stock:write');
    const query = ListBatchesQuerySchema.parse(request.query);
    return stockService.listBatches(query);
  });

  app.get('/stock/moves', async (request) => {
    await authorize(authService, request, 'stock:write');
    const query = ListStockMovesQuerySchema.parse(request.query);
    return stockService.listMoves(query);
  });

  app.post('/stock/moves/in', async (request, reply) => {
    const session = await authorize(authService, request, 'stock:write');
    const body = CreateInboundStockMoveRequestSchema.parse(request.body);
    const res = await stockService.recordInboundMove(body, session.user.id);
    return reply.code(201).send(res);
  });

  app.post('/stock/moves/out', async (request, reply) => {
    const session = await authorize(authService, request, 'stock:write');
    const body = CreateOutboundStockMoveRequestSchema.parse(request.body);
    const res = await stockService.recordOutboundMove(body, session.user.id);
    return reply.code(201).send(res);
  });

  app.get('/stock/conflicts', async (request) => {
    await authorize(authService, request, 'stock:write');
    return stockService.listConflicts();
  });

  app.get('/stock/policy', async (request) => {
    await authorize(authService, request, 'stock:write');
    return stockService.getNegativeStockPolicy();
  });

  app.put('/stock/policy', async (request) => {
    await authorize(authService, request, 'stock:write');
    const body = UpdateNegativeStockPolicyRequestSchema.parse(request.body);
    return stockService.setNegativeStockPolicy(body);
  });

  app.post('/stock/projections/rebuild', async (request) => {
    await authorize(authService, request, 'stock:write');
    return stockService.rebuildProjections();
  });

  // Inventory counts (S1 + S3 + S4)
  app.post('/stock/inventory-counts', async (request, reply) => {
    const session = await authorize(authService, request, 'stock:write');
    const body = StartInventoryCountRequestSchema.parse(request.body ?? {});
    const res = await stockService.startInventoryCount(body, session.user.id);
    return reply.code(201).send(res);
  });

  app.get('/stock/inventory-counts/:id', async (request) => {
    await authorize(authService, request, 'stock:write');
    const params = InventoryCountIdParamsSchema.parse(request.params);
    return stockService.getInventoryCount(params.id);
  });

  app.patch('/stock/inventory-counts/:id/lines', async (request) => {
    await authorize(authService, request, 'stock:write');
    const params = InventoryCountIdParamsSchema.parse(request.params);
    const body = RecordInventoryCountLinesRequestSchema.parse(request.body);
    return stockService.recordInventoryCountLines(params.id, body);
  });

  app.post('/stock/inventory-counts/:id/finalize', async (request) => {
    const session = await authorize(authService, request, 'stock:write');
    const params = InventoryCountIdParamsSchema.parse(request.params);
    return stockService.finalizeInventoryCount(params.id, session.user.id);
  });

  app.post('/stock/inventory-counts/:id/cancel', async (request) => {
    const session = await authorize(authService, request, 'stock:write');
    const params = InventoryCountIdParamsSchema.parse(request.params);
    return stockService.cancelInventoryCount(params.id, session.user.id);
  });
}
