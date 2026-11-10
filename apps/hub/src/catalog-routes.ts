import {
  CategoryIdParamsSchema,
  CreateBarcodeRequestSchema,
  CreateCategoryRequestSchema,
  CreateProductRequestSchema,
  CreateVariantRequestSchema,
  ListProductsQuerySchema,
  ProductBarcodeParamsSchema,
  ProductIdParamsSchema,
  ProductVariantParamsSchema,
  ScanBarcodeQuerySchema,
  UpdateCategoryRequestSchema,
  UpdateProductRequestSchema,
  UpdateVariantRequestSchema,
} from '@mezon/contracts';
import type { HubPermission } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HubAuthService } from './auth-service.js';
import type { HubCatalogService } from './catalog-service.js';

async function authorize(
  authService: HubAuthService,
  request: FastifyRequest,
  permission: HubPermission,
) {
  const session = await authService.authenticate(request.headers.authorization);
  authService.assertPermission(session, permission);
  return session;
}

export function registerCatalogRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  catalogService: HubCatalogService,
): void {
  // Categories
  app.get('/categories', async (request) => {
    await authorize(authService, request, 'catalog:read');
    return catalogService.listCategories();
  });

  app.post('/categories', async (request, reply) => {
    await authorize(authService, request, 'catalog:write');
    const body = CreateCategoryRequestSchema.parse(request.body);
    const res = await catalogService.createCategory(body);
    return reply.code(201).send(res);
  });

  app.patch('/categories/:id', async (request) => {
    await authorize(authService, request, 'catalog:write');
    const params = CategoryIdParamsSchema.parse(request.params);
    const body = UpdateCategoryRequestSchema.parse(request.body);
    return catalogService.updateCategory(params.id, body);
  });

  app.delete('/categories/:id', async (request) => {
    await authorize(authService, request, 'catalog:write');
    const params = CategoryIdParamsSchema.parse(request.params);
    return catalogService.deleteCategory(params.id);
  });

  // Products
  app.get('/products', async (request) => {
    await authorize(authService, request, 'catalog:read');
    const query = ListProductsQuerySchema.parse(request.query);
    return catalogService.listProducts(query);
  });

  app.get('/products/:id', async (request) => {
    await authorize(authService, request, 'catalog:read');
    const params = ProductIdParamsSchema.parse(request.params);
    return catalogService.getProduct(params.id);
  });

  app.post('/products', async (request, reply) => {
    const session = await authorize(authService, request, 'catalog:write');
    const body = CreateProductRequestSchema.parse(request.body);
    const res = await catalogService.createProduct(body, session.user.id);
    return reply.code(201).send(res);
  });

  app.patch('/products/:id', async (request) => {
    const session = await authorize(authService, request, 'catalog:write');
    const params = ProductIdParamsSchema.parse(request.params);
    const body = UpdateProductRequestSchema.parse(request.body);
    return catalogService.updateProduct(params.id, body, session.user.id);
  });

  app.delete('/products/:id', async (request) => {
    await authorize(authService, request, 'catalog:write');
    const params = ProductIdParamsSchema.parse(request.params);
    return catalogService.deleteProduct(params.id);
  });

  // Variants
  app.post('/products/:id/variants', async (request, reply) => {
    const session = await authorize(authService, request, 'catalog:write');
    const params = ProductIdParamsSchema.parse(request.params);
    const body = CreateVariantRequestSchema.parse(request.body);
    const res = await catalogService.createVariant(params.id, body, session.user.id);
    return reply.code(201).send(res);
  });

  app.patch('/products/:id/variants/:variantId', async (request) => {
    const session = await authorize(authService, request, 'catalog:write');
    const params = ProductVariantParamsSchema.parse(request.params);
    const body = UpdateVariantRequestSchema.parse(request.body);
    return catalogService.updateVariant(params.id, params.variantId, body, session.user.id);
  });

  app.delete('/products/:id/variants/:variantId', async (request) => {
    await authorize(authService, request, 'catalog:write');
    const params = ProductVariantParamsSchema.parse(request.params);
    return catalogService.deleteVariant(params.id, params.variantId);
  });

  // Barcodes
  app.post('/products/:id/barcodes', async (request, reply) => {
    await authorize(authService, request, 'catalog:write');
    const params = ProductIdParamsSchema.parse(request.params);
    const body = CreateBarcodeRequestSchema.parse(request.body);
    const res = await catalogService.createBarcode(params.id, body);
    return reply.code(201).send(res);
  });

  app.delete('/products/:id/barcodes/:barcodeId', async (request) => {
    await authorize(authService, request, 'catalog:write');
    const params = ProductBarcodeParamsSchema.parse(request.params);
    return catalogService.deleteBarcode(params.id, params.barcodeId);
  });

  // Price history (owner/manager only per approved policy)
  app.get('/products/:id/price-changes', async (request) => {
    await authorize(authService, request, 'catalog:write');
    const params = ProductIdParamsSchema.parse(request.params);
    return catalogService.listPriceChanges(params.id);
  });

  // Fast checkout barcode scan lookup
  app.get('/catalog/scan', async (request) => {
    await authorize(authService, request, 'catalog:read');
    const query = ScanBarcodeQuerySchema.parse(request.query);
    return catalogService.scanBarcode(query.code);
  });
}
