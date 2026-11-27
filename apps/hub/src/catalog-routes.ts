import {
  CategoryIdParamsSchema,
  CreateBarcodeRequestSchema,
  CreateCategoryRequestSchema,
  CreateProductRequestSchema,
  CreateVariantRequestSchema,
  ListPriceTiersQuerySchema,
  ListProductsQuerySchema,
  ProductBarcodeParamsSchema,
  ProductIdParamsSchema,
  ProductVariantParamsSchema,
  ReplacePriceTiersRequestSchema,
  ScanBarcodeQuerySchema,
  SetFavoriteRequestSchema,
  SetProductImageRequestSchema,
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

  // T3.1: badge count for the "MXIK'siz mahsulotlar" warning (no blocking; fiscal mode is T3.2).
  app.get('/products/missing-mxik/count', async (request) => {
    await authorize(authService, request, 'catalog:read');
    return catalogService.countProductsMissingMxik();
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

  // C20 wholesale price tiers: read by every till (the sale screen hint), changed by owner/manager.
  app.get('/catalog/price-tiers', async (request) => {
    await authorize(authService, request, 'catalog:read');
    const query = ListPriceTiersQuerySchema.parse(request.query);
    return catalogService.listPriceTiers(query.productIds);
  });

  app.put('/products/:id/price-tiers', async (request) => {
    await authorize(authService, request, 'catalog:write');
    const params = ProductIdParamsSchema.parse(request.params);
    const body = ReplacePriceTiersRequestSchema.parse(request.body);
    return catalogService.replacePriceTiers(params.id, body);
  });

  // C21 product photos: shown on every till, changed by owner/manager.
  app.get('/catalog/image-stamps', async (request) => {
    await authorize(authService, request, 'catalog:read');
    const query = ListPriceTiersQuerySchema.parse(request.query);
    return catalogService.listImageStamps(query.productIds);
  });

  app.get('/products/:id/image', async (request, reply) => {
    await authorize(authService, request, 'catalog:read');
    const params = ProductIdParamsSchema.parse(request.params);
    const img = await catalogService.getImage(params.id);
    return reply
      .header('content-type', img.mime)
      .header('cache-control', 'private, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .send(img.bytes);
  });

  app.get('/products/:id/image-data', async (request) => {
    await authorize(authService, request, 'catalog:read');
    const params = ProductIdParamsSchema.parse(request.params);
    return catalogService.getImageData(params.id);
  });

  app.put('/products/:id/image', async (request) => {
    await authorize(authService, request, 'catalog:write');
    const params = ProductIdParamsSchema.parse(request.params);
    const body = SetProductImageRequestSchema.parse(request.body);
    return catalogService.setImage(params.id, body);
  });

  app.delete('/products/:id/image', async (request) => {
    await authorize(authService, request, 'catalog:write');
    const params = ProductIdParamsSchema.parse(request.params);
    return catalogService.deleteImage(params.id);
  });

  // C20 favourite (starred) goods of this store: any cashier may star.
  app.get('/catalog/favorites', async (request) => {
    await authorize(authService, request, 'catalog:read');
    return catalogService.listFavorites();
  });

  app.put('/catalog/favorites/:id', async (request) => {
    await authorize(authService, request, 'catalog:read');
    const params = ProductIdParamsSchema.parse(request.params);
    const body = SetFavoriteRequestSchema.parse(request.body);
    return catalogService.setFavorite(params.id, body.favorite);
  });

  // Fast checkout barcode scan lookup
  app.get('/catalog/scan', async (request) => {
    await authorize(authService, request, 'catalog:read');
    const query = ScanBarcodeQuerySchema.parse(request.query);
    return catalogService.scanBarcode(query.code);
  });
}
