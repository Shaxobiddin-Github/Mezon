import {
  CreateUserRequestSchema,
  LoginRequestSchema,
  ResetUserPinRequestSchema,
  SetupRequestSchema,
  UpdateUserRequestSchema,
  UserIdParamsSchema,
} from '@mezon/contracts';
import type { HubPermission } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HubAuthService } from './auth-service.js';
import { registerCatalogRoutes } from './catalog-routes.js';
import type { HubCatalogService } from './catalog-service.js';
import { registerCartRoutes } from './cart-routes.js';
import type { HubCartService } from './cart-service.js';
import type { HubSaleService } from './sale-service.js';
import { registerReturnRoutes } from './return-routes.js';
import type { HubReturnService } from './return-service.js';
import { registerStockRoutes } from './stock-routes.js';
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

export function registerHubRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  catalogService?: HubCatalogService,
  stockService?: HubStockService,
  cartService?: HubCartService,
  saleService?: HubSaleService,
  returnService?: HubReturnService,
): void {
  app.get('/health', async () => {
    return authService.getHealth();
  });

  app.post('/setup', async (request, reply) => {
    const body = SetupRequestSchema.parse(request.body);
    const res = await authService.setup(body);
    return reply.code(201).send(res);
  });

  app.get('/auth/login-options', async () => {
    return authService.listLoginOptions();
  });

  app.post('/auth/login', async (request) => {
    const body = LoginRequestSchema.parse(request.body);
    return authService.login(body);
  });

  app.post('/auth/logout', async (request) => {
    const session = await authorize(authService, request, 'auth:self');
    return authService.logout(session);
  });

  app.get('/auth/me', async (request) => {
    const session = await authorize(authService, request, 'auth:self');
    return authService.me(session);
  });

  app.get('/users', async (request) => {
    await authorize(authService, request, 'users:read');
    return authService.listUsers();
  });

  app.post('/users', async (request, reply) => {
    await authorize(authService, request, 'users:write');
    const body = CreateUserRequestSchema.parse(request.body);
    const res = await authService.createUser(body);
    return reply.code(201).send(res);
  });

  app.patch('/users/:id', async (request) => {
    await authorize(authService, request, 'users:write');
    const params = UserIdParamsSchema.parse(request.params);
    const body = UpdateUserRequestSchema.parse(request.body);
    return authService.updateUser(params.id, body);
  });

  app.post('/users/:id/pin', async (request) => {
    await authorize(authService, request, 'users:write');
    const params = UserIdParamsSchema.parse(request.params);
    const body = ResetUserPinRequestSchema.parse(request.body);
    return authService.resetUserPin(params.id, body);
  });

  app.post('/users/:id/unlock', async (request) => {
    await authorize(authService, request, 'users:unlock');
    const params = UserIdParamsSchema.parse(request.params);
    return authService.unlockUser(params.id);
  });

  app.delete('/users/:id', async (request) => {
    await authorize(authService, request, 'users:write');
    const params = UserIdParamsSchema.parse(request.params);
    return authService.deleteUser(params.id);
  });

  if (catalogService) {
    registerCatalogRoutes(app, authService, catalogService);
  }
  if (stockService) {
    registerStockRoutes(app, authService, stockService);
  }
  if (cartService) {
    registerCartRoutes(app, authService, cartService, saleService);
  }
  if (returnService) {
    registerReturnRoutes(app, authService, returnService);
  }
}
