import type {
  BarcodeResponseDto,
  CategoryResponseDto,
  CategorySummaryDto,
  CreateBarcodeRequestDto,
  CreateCategoryRequestDto,
  CreateProductRequestDto,
  CreateVariantRequestDto,
  DeleteBarcodeResponseDto,
  DeleteCategoryResponseDto,
  DeleteProductResponseDto,
  DeleteVariantResponseDto,
  ListCategoriesResponseDto,
  ListPriceChangesResponseDto,
  ListProductsQueryDto,
  ListProductsResponseDto,
  PriceChangeSummaryDto,
  ProductBarcodeSummaryDto,
  ProductDetailResponseDto,
  ProductResponseDto,
  ProductSummaryDto,
  ProductVariantSummaryDto,
  ScanBarcodeResponseDto,
  UpdateCategoryRequestDto,
  UpdateProductRequestDto,
  UpdateVariantRequestDto,
  VariantResponseDto,
} from '@mezon/contracts';
import type {
  SqliteCatalogStore,
  StoredCategoryRecord,
  StoredPriceChangeRecord,
  StoredProductBarcodeRecord,
  StoredProductRecord,
  StoredProductVariantRecord,
} from '@mezon/db-local';
import { DomainError, type UuidV7 } from '@mezon/domain';

/**
 * Explicit allow-listed DTO mappers (`GEMINI.md` 3.4).
 * Never spread internal DB records so sensitive/derived fields cannot leak into API responses.
 */
function toCategoryDto(cat: StoredCategoryRecord): CategorySummaryDto {
  return {
    id: cat.id,
    organizationId: cat.organizationId,
    name: cat.name,
    parentId: cat.parentId,
    sortOrder: cat.sortOrder,
    createdAtMs: cat.createdAtMs.toString(),
    updatedAtMs: cat.updatedAtMs.toString(),
  };
}

function toProductDto(product: StoredProductRecord): ProductSummaryDto {
  return {
    id: product.id,
    organizationId: product.organizationId,
    categoryId: product.categoryId,
    sku: product.sku,
    name: product.name,
    unit: product.unit,
    unlimited: product.unlimited,
    minStock: product.minStock !== null ? product.minStock.toString() : null,
    hasVariants: product.hasVariants,
    trackBatches: product.trackBatches,
    salePrice: product.salePrice.toString(),
    mxik: product.mxik,
    packageCode: product.packageCode,
    vatRateBp: product.vatRateBp,
    createdAtMs: product.createdAtMs.toString(),
    updatedAtMs: product.updatedAtMs.toString(),
  };
}

function toVariantDto(variant: StoredProductVariantRecord): ProductVariantSummaryDto {
  return {
    id: variant.id,
    organizationId: variant.organizationId,
    productId: variant.productId,
    name: variant.name,
    sku: variant.sku,
    attributes: variant.attributes,
    salePrice: variant.salePrice !== null ? variant.salePrice.toString() : null,
    effectiveSalePrice: variant.effectiveSalePrice.toString(),
    createdAtMs: variant.createdAtMs.toString(),
    updatedAtMs: variant.updatedAtMs.toString(),
  };
}

function toBarcodeDto(bc: StoredProductBarcodeRecord): ProductBarcodeSummaryDto {
  return {
    id: bc.id,
    organizationId: bc.organizationId,
    productId: bc.productId,
    variantId: bc.variantId,
    barcode: bc.barcode,
    format: bc.format,
    createdAtMs: bc.createdAtMs.toString(),
    updatedAtMs: bc.updatedAtMs.toString(),
  };
}

function toPriceChangeDto(pc: StoredPriceChangeRecord): PriceChangeSummaryDto {
  return {
    id: pc.id,
    organizationId: pc.organizationId,
    productId: pc.productId,
    variantId: pc.variantId,
    oldPrice: pc.oldPrice !== null ? pc.oldPrice.toString() : null,
    newPrice: pc.newPrice.toString(),
    changedByUserId: pc.changedByUserId,
    reason: pc.reason,
    createdAtMs: pc.createdAtMs.toString(),
  };
}

export class HubCatalogService {
  private readonly store: SqliteCatalogStore;

  constructor(store: SqliteCatalogStore) {
    this.store = store;
  }

  async listCategories(): Promise<ListCategoriesResponseDto> {
    const rows = await this.store.listCategories();
    return { categories: rows.map(toCategoryDto) };
  }

  async createCategory(input: CreateCategoryRequestDto): Promise<CategoryResponseDto> {
    const category = await this.store.createCategory(input);
    return { category: toCategoryDto(category) };
  }

  async updateCategory(
    categoryId: UuidV7,
    patch: UpdateCategoryRequestDto,
  ): Promise<CategoryResponseDto> {
    const category = await this.store.updateCategory(categoryId, patch);
    return { category: toCategoryDto(category) };
  }

  async deleteCategory(categoryId: UuidV7): Promise<DeleteCategoryResponseDto> {
    await this.store.deleteCategory(categoryId);
    return { deleted: true, id: categoryId };
  }

  async listProducts(query: ListProductsQueryDto): Promise<ListProductsResponseDto> {
    const page = await this.store.listProducts(query);
    return {
      products: page.products.map(toProductDto),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    };
  }

  async getProduct(productId: UuidV7): Promise<ProductDetailResponseDto> {
    const detail = await this.store.getProductDetail(productId);
    return {
      product: toProductDto(detail.product),
      variants: detail.variants.map(toVariantDto),
      barcodes: detail.barcodes.map(toBarcodeDto),
    };
  }

  async createProduct(
    input: CreateProductRequestDto,
    actorUserId: UuidV7,
  ): Promise<ProductDetailResponseDto> {
    const created = await this.store.createProduct({
      ...input,
      actorUserId,
    });
    return {
      product: toProductDto(created.product),
      variants: created.variants.map(toVariantDto),
      barcodes: created.barcodes.map(toBarcodeDto),
    };
  }

  async updateProduct(
    productId: UuidV7,
    patch: UpdateProductRequestDto,
    actorUserId: UuidV7,
  ): Promise<ProductResponseDto> {
    const updated = await this.store.updateProduct(productId, {
      ...patch,
      actorUserId,
    });
    return { product: toProductDto(updated) };
  }

  async deleteProduct(productId: UuidV7): Promise<DeleteProductResponseDto> {
    await this.store.deleteProduct(productId);
    return { deleted: true, id: productId };
  }

  async createVariant(
    productId: UuidV7,
    input: CreateVariantRequestDto,
    actorUserId: UuidV7,
  ): Promise<VariantResponseDto> {
    const variant = await this.store.createVariant(productId, {
      ...input,
      actorUserId,
    });
    return { variant: toVariantDto(variant) };
  }

  async updateVariant(
    productId: UuidV7,
    variantId: UuidV7,
    patch: UpdateVariantRequestDto,
    actorUserId: UuidV7,
  ): Promise<VariantResponseDto> {
    const variant = await this.store.updateVariant(productId, variantId, {
      ...patch,
      actorUserId,
    });
    return { variant: toVariantDto(variant) };
  }

  async deleteVariant(productId: UuidV7, variantId: UuidV7): Promise<DeleteVariantResponseDto> {
    await this.store.deleteVariant(productId, variantId);
    return { deleted: true, id: variantId };
  }

  async createBarcode(
    productId: UuidV7,
    input: CreateBarcodeRequestDto,
  ): Promise<BarcodeResponseDto> {
    const barcode = await this.store.createBarcode(productId, input);
    return { barcode: toBarcodeDto(barcode) };
  }

  async deleteBarcode(productId: UuidV7, barcodeId: UuidV7): Promise<DeleteBarcodeResponseDto> {
    await this.store.deleteBarcode(productId, barcodeId);
    return { deleted: true, id: barcodeId };
  }

  async listPriceChanges(productId: UuidV7): Promise<ListPriceChangesResponseDto> {
    const rows = await this.store.listPriceChanges(productId);
    return { priceChanges: rows.map(toPriceChangeDto) };
  }

  async scanBarcode(code: string): Promise<ScanBarcodeResponseDto> {
    const hit = await this.store.scanBarcode(code);
    if (hit === null) {
      throw new DomainError('BARCODE_NOT_FOUND', 'Barcode not found in catalog');
    }
    return {
      product: toProductDto(hit.product),
      variant: hit.variant !== null ? toVariantDto(hit.variant) : null,
      barcode: toBarcodeDto(hit.barcode),
      quantity: null,
    };
  }
}
