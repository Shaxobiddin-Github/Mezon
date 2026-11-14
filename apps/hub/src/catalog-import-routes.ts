import { ExcelImportCommitRequestSchema } from '@mezon/contracts';
import type { SqliteCatalogStore, SqliteStockStore } from '@mezon/db-local';
import { DomainError, type HubPermission, parseProductUnit } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HubAuthService } from './auth-service.js';
import { CatalogImportCache } from './catalog-import-cache.js';
import { ExcelPort } from './excel-port.js';

async function authorize(
  authService: HubAuthService,
  request: FastifyRequest,
  permission: HubPermission,
) {
  const session = await authService.authenticate(request.headers.authorization);
  authService.assertPermission(session, permission);
  return session;
}

export function registerCatalogImportRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  catalogStore: SqliteCatalogStore,
  stockStore: SqliteStockStore,
  importCache: CatalogImportCache,
): void {
  // 1. Preview Excel Import (R4: parses, validates, caches preview with previewToken)
  app.post('/catalog/import/preview', async (request) => {
    await authorize(authService, request, 'catalog:write');

    let buffer: Buffer;
    // Accept either raw binary/buffer or JSON with { fileBase64: string }
    const contentType = request.headers['content-type'] ?? '';
    if (contentType.includes('application/json')) {
      const body = request.body as { readonly fileBase64?: string };
      if (!body.fileBase64) {
        throw new DomainError('VALIDATION_ERROR', 'fileBase64 maydoni kiritilishi shart');
      }
      buffer = Buffer.from(body.fileBase64, 'base64');
    } else if (Buffer.isBuffer(request.body)) {
      buffer = request.body;
    } else {
      throw new DomainError(
        'VALIDATION_ERROR',
        'Excel fayli JSON base64 yoki binary formatda yuborilishi kerak',
      );
    }

    if (buffer.length > 10 * 1024 * 1024) {
      throw new DomainError('VALIDATION_ERROR', 'Fayl hajmi 10 MB dan oshmasligi kerak');
    }

    const parsed = await ExcelPort.parseImportWorkbook(buffer);

    // Check conflicts with existing products in catalog
    const conflicts: {
      rowNumber: number;
      barcode: string;
      existingProductName: string;
      message: string;
    }[] = [];

    const existingBarcodes = new Set<string>();
    for (const row of parsed.validRows) {
      if (row.barcode) {
        try {
          const scanRes = await catalogStore.scanBarcode(row.barcode);
          if (scanRes) {
            conflicts.push({
              rowNumber: row.rowNumber,
              barcode: row.barcode,
              existingProductName: scanRes.product.name,
              message: `Shtrixkod "${row.barcode}" allaqachon mavjud: "${scanRes.product.name}"`,
            });
            existingBarcodes.add(row.barcode);
          }
        } catch {
          // No collision
        }
      }
    }

    const previewToken = importCache.savePreview(parsed.validRows);

    return {
      previewToken,
      expiresAtMs: (Date.now() + 15 * 60 * 1000).toString(),
      totalRows: parsed.totalRows,
      validRows: parsed.validRows.length,
      createsCount: parsed.validRows.filter((r) => !r.barcode || !existingBarcodes.has(r.barcode))
        .length,
      updatesCount: 0,
      errors: parsed.invalidRows.map((inv) => ({
        rowNumber: inv.rowNumber,
        message: inv.error ?? 'Notoʻgʻri qator',
      })),
      conflicts,
      rows: parsed.validRows.map((r) => ({
        rowNumber: r.rowNumber,
        action:
          r.barcode && existingBarcodes.has(r.barcode) ? ('skip' as const) : ('create' as const),
        barcode: r.barcode ?? null,
        name: r.name,
        sku: r.sku ?? null,
        unit: r.unit,
        salePrice: r.salePriceTiyin.toString(),
        costPrice: r.costPriceTiyin ? r.costPriceTiyin.toString() : null,
        minStockMilli: r.minStockMilli ? r.minStockMilli.toString() : null,
        initialStockMilli: null,
      })),
    };
  });

  // 2. Commit Excel Import (R4: takes previewToken, re-validates barcodes inside UoW)
  app.post('/catalog/import/commit', async (request) => {
    const session = await authorize(authService, request, 'catalog:write');
    const body = ExcelImportCommitRequestSchema.parse(request.body);

    const cachedRows = importCache.getPreview(body.previewToken);
    if (!cachedRows) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'Import tokeni eskirgan yoki topilmadi. Qayta fayl yuklang.',
      );
    }

    // R4 Live re-validation against database to avoid concurrent collisions
    let importedProductsCount = 0;

    for (const row of cachedRows) {
      if (row.barcode) {
        const existing = await catalogStore.scanBarcode(row.barcode);
        if (existing) {
          // Skip or reject if barcode collided concurrently
          continue;
        }
      }

      // Create product
      const barcodes = row.barcode ? [{ barcode: row.barcode }] : [];
      await catalogStore.createProduct({
        actorUserId: session.user.id,
        name: row.name,
        sku: row.sku ?? null,
        unit: parseProductUnit(row.unit),
        salePrice: row.salePriceTiyin.toString(),
        minStock: row.minStockMilli ? row.minStockMilli.toString() : null,
        barcodes,
      });

      importedProductsCount++;
    }

    // Clean up cache
    importCache.deletePreview(body.previewToken);

    return {
      importedProductsCount,
      updatedProductsCount: 0,
      initialStockMovesCount: 0,
      idempotentReplay: false,
    };
  });

  // 3. Catalog Excel Export
  app.get('/catalog/export', async (request, reply) => {
    const session = await authorize(authService, request, 'catalog:read');
    const isOwner = session.user.role === 'owner';

    // List all catalog products
    const listRes = await catalogStore.listProducts({ limit: 5000 });
    const buffer = await ExcelPort.generateCatalogWorkbook(listRes.products, {
      includeCost: isOwner,
    });

    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="catalog-products.xlsx"')
      .send(buffer);
  });
}
