import {
  type CartMarkDto,
  CartMarksListResponseSchema,
  type CartMarksResponseDto,
  CartMarksResponseSchema,
  type IntegrationsStatusResponse,
  IntegrationsStatusResponseSchema,
  type LoadDemoCatalogResponse,
  LoadDemoCatalogResponseSchema,
  type PaymentIntentDto,
  PaymentIntentResponseSchema,
  SetFiscalModeResponseSchema,
  type LicenceStatusResponseDto,
  LicenceStatusResponseSchema,
  type FiscalDocDto,
  FiscalDocResponseSchema,
  type FiscalStatusResponse,
  FiscalStatusResponseSchema,
  FiscalUnsettledListResponseSchema,
  ResolveSyncConflictResponseSchema,
  type CloudParkedEventDto,
  CloudParkedListResponseSchema,
  CloudResolveParkedResponseSchema,
  type ResolveSyncConflictResponseDto,
  type SyncConflictDto,
  SyncConflictListResponseSchema,
  SaleFiscalResponseSchema,
  type RulesCheckRequestDto,
  RulesCheckResponseSchema,
  type RulesCheckResponseDto,
  type CreateProductRequestDto,
  MissingMxikCountResponseSchema,
  type MissingMxikCountResponseDto,
  ProductDetailResponseSchema,
  type ProductDetailResponseDto,
  ListSalesResponseSchema,
  type ListSalesResponseDto,
  SaleReturnContextResponseSchema,
  type SaleReturnContextResponseDto,
  CreateReturnRequestSchema,
  type CreateReturnRequestDto,
  CreateReturnResponseSchema,
  type CreateReturnResponseDto,
  BarcodeResponseSchema,
  type BarcodeResponseDto,
  CategoryResponseSchema,
  type CategoryResponseDto,
  type CreateBarcodeRequestDto,
  type CreateCategoryRequestDto,
  DeleteBarcodeResponseSchema,
  type DeleteBarcodeResponseDto,
  ProductResponseSchema,
  type ProductResponseDto,
  TaxProfileResponseSchema,
  type TaxProfileResponseDto,
  type UpdateProductRequestDto,
  type UpdateTaxProfileRequestDto,
  type AddCartLineRequestDto,
  AddCartLineRequestSchema,
  ApiErrorEnvelopeSchema,
  type AuthMeResponseDto,
  AuthMeResponseSchema,
  type CartResponseDto,
  CartResponseSchema,
  type CartSettingsResponseDto,
  CartSettingsResponseSchema,
  type CloseShiftRequestDto,
  CloseShiftRequestSchema,
  type CloseShiftResponseDto,
  CloseShiftResponseSchema,
  type CompleteSaleRequestDto,
  CompleteSaleRequestSchema,
  type CompleteSaleResponseDto,
  CompleteSaleResponseSchema,
  type PrintDocumentRequestDto,
  PrintDocumentRequestSchema,
  type PrintDocumentResponseDto,
  PrintDocumentResponseSchema,
  type PrinterSettingsResponseDto,
  PrinterSettingsResponseSchema,
  type CreateCustomerRequestDto,
  CreateCustomerRequestSchema,
  type CreateShiftCashMoveRequestDto,
  CreateShiftCashMoveRequestSchema,
  type CurrentShiftResponseDto,
  CurrentShiftResponseSchema,
  type CustomerListQueryDto,
  type CustomerListResponseDto,
  CustomerListResponseSchema,
  type CustomerMutationResponseDto,
  CustomerMutationResponseSchema,
  type DeleteCartResponseDto,
  DeleteCartResponseSchema,
  type HealthResponseDto,
  HealthResponseSchema,
  type ListCartsResponseDto,
  ListCartsResponseSchema,
  type ListCategoriesResponseDto,
  ListCategoriesResponseSchema,
  type ListProductsQueryDto,
  type ListProductsResponseDto,
  ListProductsResponseSchema,
  type LoginOptionsResponseDto,
  LoginOptionsResponseSchema,
  type LoginRequestDto,
  LoginRequestSchema,
  type LoginResponseDto,
  LoginResponseSchema,
  type LogoutResponseDto,
  LogoutResponseSchema,
  type OpenShiftRequestDto,
  OpenShiftRequestSchema,
  type OpenShiftResponseDto,
  OpenShiftResponseSchema,
  type ParkCartRequestDto,
  ParkCartRequestSchema,
  type ScanBarcodeResponseDto,
  ScanBarcodeResponseSchema,
  type SetCartDiscountRequestDto,
  SetCartDiscountRequestSchema,
  type SetupRequestDto,
  SetupRequestSchema,
  type SetupResponseDto,
  SetupResponseSchema,
  type ShiftCashMoveResponseDto,
  ShiftCashMoveResponseSchema,
  type UpdateCartLineRequestDto,
  UpdateCartLineRequestSchema,
  type DailySalesReportQueryDto,
  type DailySalesReportResponseDto,
  DailySalesReportResponseSchema,
  type MonthlySalesReportQueryDto,
  type MonthlySalesReportResponseDto,
  MonthlySalesReportResponseSchema,
  type ProfitReportQueryDto,
  type ProfitReportResponseDto,
  ProfitReportResponseSchema,
  type DebtsReportQueryDto,
  type DebtsReportResponseDto,
  DebtsReportResponseSchema,
  type LowStockReportQueryDto,
  type LowStockReportResponseDto,
  LowStockReportResponseSchema,
  type ExpiringBatchesReportQueryDto,
  type ExpiringBatchesReportResponseDto,
  ExpiringBatchesReportResponseSchema,
  type BackupListResponseDto,
  BackupListResponseSchema,
  type CreateBackupRequestDto,
  CreateBackupRequestSchema,
  type CreateBackupResponseDto,
  CreateBackupResponseSchema,
  type StageRestoreRequestDto,
  StageRestoreRequestSchema,
  type StageRestoreResponseDto,
  StageRestoreResponseSchema,
  type ExcelImportPreviewResponseDto,
  ExcelImportPreviewResponseSchema,
  type ExcelImportCommitRequestDto,
  ExcelImportCommitRequestSchema,
  type ExcelImportCommitResponseDto,
  ExcelImportCommitResponseSchema,
} from '@mezon/contracts';
import {
  type HubCloudStatusDto,
  HubCloudStatusSchema,
  HubPairCloudRequestSchema,
} from '@mezon/contracts';
import { z } from 'zod';
import { normalizeLoopbackHubBaseUrl } from '../bridge.js';

export class HubApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryAfterSeconds?: number;
  readonly isNetworkError: boolean;

  constructor(params: {
    readonly status: number;
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly retryAfterSeconds?: number;
    readonly isNetworkError?: boolean;
  }) {
    super(params.message);
    this.name = 'HubApiError';
    this.status = params.status;
    this.code = params.code;
    this.details = params.details;
    this.retryAfterSeconds = params.retryAfterSeconds;
    this.isNetworkError = params.isNetworkError === true;
  }
}

export interface HubClientOptions {
  readonly getBaseUrl: () => string | null;
  readonly getToken: () => string | null;
}

export class HubApiClient {
  private readonly getBaseUrl: () => string | null;
  private readonly getToken: () => string | null;

  constructor(options: HubClientOptions) {
    this.getBaseUrl = options.getBaseUrl;
    this.getToken = options.getToken;
  }

  private async request<TOut>(params: {
    readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    readonly path: string;
    readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
    readonly body?: unknown;
    readonly responseSchema: z.ZodType<TOut>;
    readonly authenticated?: boolean;
  }): Promise<TOut> {
    const rawBaseUrl = this.getBaseUrl();
    if (!rawBaseUrl) {
      throw new HubApiError({
        status: 0,
        code: 'NETWORK_ERROR',
        message: 'Hub base URL is not ready',
        isNetworkError: true,
      });
    }

    const baseUrl = normalizeLoopbackHubBaseUrl(rawBaseUrl);
    const url = new URL(params.path, baseUrl);
    if (params.query) {
      for (const [key, val] of Object.entries(params.query)) {
        if (val !== undefined) {
          url.searchParams.set(key, String(val));
        }
      }
    }

    const headers: Record<string, string> = {};
    if (params.authenticated !== false) {
      const token = this.getToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }
    if (params.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: params.method,
        headers,
        body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
      });
    } catch (err) {
      throw new HubApiError({
        status: 0,
        code: 'NETWORK_ERROR',
        message: err instanceof Error ? err.message : 'Network error',
        isNetworkError: true,
      });
    }

    let rawJson: unknown = null;
    try {
      rawJson = await response.json();
    } catch {
      rawJson = null;
    }

    if (!response.ok) {
      const retryAfterRaw = response.headers.get('retry-after');
      const retryAfterSeconds =
        retryAfterRaw !== null && /^\d+$/.test(retryAfterRaw.trim())
          ? Number(retryAfterRaw.trim())
          : undefined;
      const parsedError = ApiErrorEnvelopeSchema.safeParse(rawJson);
      if (parsedError.success) {
        throw new HubApiError({
          status: response.status,
          code: parsedError.data.error.code,
          message: parsedError.data.error.message,
          details: parsedError.data.error.details,
          retryAfterSeconds,
        });
      }
      throw new HubApiError({
        status: response.status,
        code: `HTTP_${String(response.status)}`,
        message: `HTTP error ${String(response.status)}`,
        retryAfterSeconds,
      });
    }

    return params.responseSchema.parse(rawJson);
  }

  // --- Health & Setup & Auth ---

  async getHealth(): Promise<HealthResponseDto> {
    return this.request({
      method: 'GET',
      path: '/health',
      responseSchema: HealthResponseSchema,
      authenticated: false,
    });
  }

  async setup(input: z.input<typeof SetupRequestSchema>): Promise<SetupResponseDto> {
    const validated: SetupRequestDto = SetupRequestSchema.parse(input);
    return this.request({
      method: 'POST',
      path: '/setup',
      body: validated,
      responseSchema: SetupResponseSchema,
      authenticated: false,
    });
  }

  async getLoginOptions(): Promise<LoginOptionsResponseDto> {
    return this.request({
      method: 'GET',
      path: '/auth/login-options',
      responseSchema: LoginOptionsResponseSchema,
      authenticated: false,
    });
  }

  async login(input: z.input<typeof LoginRequestSchema>): Promise<LoginResponseDto> {
    const validated: LoginRequestDto = LoginRequestSchema.parse(input);
    return this.request({
      method: 'POST',
      path: '/auth/login',
      body: validated,
      responseSchema: LoginResponseSchema,
      authenticated: false,
    });
  }

  async logout(): Promise<LogoutResponseDto> {
    return this.request({
      method: 'POST',
      path: '/auth/logout',
      responseSchema: LogoutResponseSchema,
    });
  }

  async me(): Promise<AuthMeResponseDto> {
    return this.request({
      method: 'GET',
      path: '/auth/me',
      responseSchema: AuthMeResponseSchema,
    });
  }

  // --- Shifts & Cash Moves ---

  async getCurrentShift(): Promise<CurrentShiftResponseDto> {
    return this.request({
      method: 'GET',
      path: '/shifts/current',
      responseSchema: CurrentShiftResponseSchema,
    });
  }

  async openShift(input: z.input<typeof OpenShiftRequestSchema>): Promise<OpenShiftResponseDto> {
    const validated: OpenShiftRequestDto = OpenShiftRequestSchema.parse(input);
    return this.request({
      method: 'POST',
      path: '/shifts/open',
      body: validated,
      responseSchema: OpenShiftResponseSchema,
    });
  }

  async closeShift(
    shiftId: string,
    input: z.input<typeof CloseShiftRequestSchema>,
  ): Promise<CloseShiftResponseDto> {
    const validated: CloseShiftRequestDto = CloseShiftRequestSchema.parse(input);
    return this.request({
      method: 'POST',
      path: `/shifts/${encodeURIComponent(shiftId)}/close`,
      body: validated,
      responseSchema: CloseShiftResponseSchema,
    });
  }

  async recordShiftCashMove(
    shiftId: string,
    input: z.input<typeof CreateShiftCashMoveRequestSchema>,
  ): Promise<ShiftCashMoveResponseDto> {
    const validated: CreateShiftCashMoveRequestDto = CreateShiftCashMoveRequestSchema.parse(input);
    return this.request({
      method: 'POST',
      path: `/shifts/${encodeURIComponent(shiftId)}/cash-moves`,
      body: validated,
      responseSchema: ShiftCashMoveResponseSchema,
    });
  }

  // --- Catalog ---

  async listCategories(): Promise<ListCategoriesResponseDto> {
    return this.request({
      method: 'GET',
      path: '/categories',
      responseSchema: ListCategoriesResponseSchema,
    });
  }

  async createCategory(input: CreateCategoryRequestDto): Promise<CategoryResponseDto> {
    return this.request({
      method: 'POST',
      path: '/categories',
      body: input,
      responseSchema: CategoryResponseSchema,
    });
  }

  async getProduct(productId: string): Promise<ProductDetailResponseDto> {
    return this.request({
      method: 'GET',
      path: `/products/${encodeURIComponent(productId)}`,
      responseSchema: ProductDetailResponseSchema,
    });
  }

  async addProductBarcode(
    productId: string,
    input: CreateBarcodeRequestDto,
  ): Promise<BarcodeResponseDto> {
    return this.request({
      method: 'POST',
      path: `/products/${encodeURIComponent(productId)}/barcodes`,
      body: input,
      responseSchema: BarcodeResponseSchema,
    });
  }

  async deleteProductBarcode(
    productId: string,
    barcodeId: string,
  ): Promise<DeleteBarcodeResponseDto> {
    return this.request({
      method: 'DELETE',
      path: `/products/${encodeURIComponent(productId)}/barcodes/${encodeURIComponent(barcodeId)}`,
      responseSchema: DeleteBarcodeResponseSchema,
    });
  }

  async listProducts(query: ListProductsQueryDto): Promise<ListProductsResponseDto> {
    return this.request({
      method: 'GET',
      path: '/products',
      query: {
        q: query.q,
        categoryId: query.categoryId,
        limit: query.limit,
        offset: query.offset,
        missingMxik: query.missingMxik === true ? 'true' : undefined,
      },
      responseSchema: ListProductsResponseSchema,
    });
  }

  // --- T3.1 Catalog management & tax settings ---

  async countProductsMissingMxik(): Promise<MissingMxikCountResponseDto> {
    return this.request({
      method: 'GET',
      path: '/products/missing-mxik/count',
      responseSchema: MissingMxikCountResponseSchema,
    });
  }

  async createProduct(input: CreateProductRequestDto): Promise<ProductDetailResponseDto> {
    return this.request({
      method: 'POST',
      path: '/products',
      body: input,
      responseSchema: ProductDetailResponseSchema,
    });
  }

  async updateProduct(
    productId: string,
    input: UpdateProductRequestDto,
  ): Promise<ProductResponseDto> {
    return this.request({
      method: 'PATCH',
      path: `/products/${encodeURIComponent(productId)}`,
      body: input,
      responseSchema: ProductResponseSchema,
    });
  }

  async rulesCheck(cartId: string, input: RulesCheckRequestDto): Promise<RulesCheckResponseDto> {
    return this.request({
      method: 'POST',
      path: `/carts/${encodeURIComponent(cartId)}/rules-check`,
      body: input,
      responseSchema: RulesCheckResponseSchema,
    });
  }

  /** Owner: fiscal mode on/off (the hub checks rules package, driver, MXIK and receipt fields). */
  async setFiscalMode(enabled: boolean): Promise<boolean> {
    const res = await this.request({
      method: 'PUT',
      path: '/fiscal/mode',
      body: { enabled },
      responseSchema: SetFiscalModeResponseSchema,
    });
    return res.modeEnabled;
  }

  /** V2: what is real and what is a demo (fiscal, QR payment, marking, rules package). */
  async getIntegrations(): Promise<IntegrationsStatusResponse> {
    return this.request({
      method: 'GET',
      path: '/settings/integrations',
      responseSchema: IntegrationsStatusResponseSchema,
    });
  }

  /** C18: owner loads the 100-goods starter catalog into an empty kassa. */
  async loadDemoCatalog(): Promise<LoadDemoCatalogResponse> {
    return this.request({
      method: 'POST',
      path: '/settings/demo-catalog',
      body: {},
      responseSchema: LoadDemoCatalogResponseSchema,
    });
  }

  async setDemoMode(enabled: boolean): Promise<IntegrationsStatusResponse> {
    return this.request({
      method: 'PUT',
      path: '/settings/demo',
      body: { enabled },
      responseSchema: IntegrationsStatusResponseSchema,
    });
  }

  async setMarkingPrefixes(prefixes: readonly string[]): Promise<IntegrationsStatusResponse> {
    return this.request({
      method: 'PUT',
      path: '/settings/marking-prefixes',
      body: { prefixes },
      responseSchema: IntegrationsStatusResponseSchema,
    });
  }

  /** V2 UzQR: a dynamic QR for `amountTiyin` (the provider dedupes on the intent id). */
  async createPaymentIntent(cartId: string | null, amountTiyin: string): Promise<PaymentIntentDto> {
    const res = await this.request({
      method: 'POST',
      path: '/payments/intents',
      body: { cartId, amount: amountTiyin, kind: 'dynamic' },
      responseSchema: PaymentIntentResponseSchema,
    });
    return res.intent;
  }

  async refreshPaymentIntent(id: string): Promise<PaymentIntentDto> {
    const res = await this.request({
      method: 'GET',
      path: `/payments/intents/${encodeURIComponent(id)}`,
      responseSchema: PaymentIntentResponseSchema,
    });
    return res.intent;
  }

  async cancelPaymentIntent(id: string): Promise<PaymentIntentDto> {
    const res = await this.request({
      method: 'POST',
      path: `/payments/intents/${encodeURIComponent(id)}/cancel`,
      responseSchema: PaymentIntentResponseSchema,
    });
    return res.intent;
  }

  /** Demo mode only: "the customer paid" for a test-provider QR. */
  async demoPayPaymentIntent(id: string): Promise<PaymentIntentDto> {
    const res = await this.request({
      method: 'POST',
      path: `/payments/intents/${encodeURIComponent(id)}/demo-pay`,
      responseSchema: PaymentIntentResponseSchema,
    });
    return res.intent;
  }

  /** V2 marking: a scanned DataMatrix (GS1) code for a product that needs one per unit. */
  async scanMark(cartId: string, code: string): Promise<CartMarksResponseDto> {
    return this.request({
      method: 'POST',
      path: `/carts/${encodeURIComponent(cartId)}/marks`,
      body: { code },
      responseSchema: CartMarksResponseSchema,
    });
  }

  async listMarks(cartId: string): Promise<readonly CartMarkDto[]> {
    const res = await this.request({
      method: 'GET',
      path: `/carts/${encodeURIComponent(cartId)}/marks`,
      responseSchema: CartMarksListResponseSchema,
    });
    return res.marks;
  }

  async removeMark(cartId: string, markId: string): Promise<CartMarksResponseDto> {
    return this.request({
      method: 'DELETE',
      path: `/carts/${encodeURIComponent(cartId)}/marks/${encodeURIComponent(markId)}`,
      responseSchema: CartMarksResponseSchema,
    });
  }

  async getFiscalStatus(): Promise<FiscalStatusResponse> {
    return this.request({
      method: 'GET',
      path: '/fiscal/status',
      responseSchema: FiscalStatusResponseSchema,
    });
  }

  /** T4.7 licence state for the banner; never used to block sales. */
  async getLicenceStatus(): Promise<LicenceStatusResponseDto> {
    return this.request({
      method: 'GET',
      path: '/licence/status',
      responseSchema: LicenceStatusResponseSchema,
    });
  }

  /** T2.6: this hub's pushes parked in the cloud (proxied by the hub). */
  async listCloudParked(): Promise<readonly CloudParkedEventDto[]> {
    const res = await this.request({
      method: 'GET',
      path: '/sync/cloud-parked',
      responseSchema: CloudParkedListResponseSchema,
    });
    return res.parked;
  }

  async resolveCloudParked(
    id: string,
    action: 'retry' | 'acknowledge',
    note: string,
  ): Promise<CloudParkedEventDto> {
    const res = await this.request({
      method: 'POST',
      path: `/sync/cloud-parked/${encodeURIComponent(id)}/resolve`,
      body: note.trim().length > 0 ? { action, note: note.trim() } : { action },
      responseSchema: CloudResolveParkedResponseSchema,
    });
    return res.parked;
  }

  /** T2.6: open sync conflicts (manager / owner). */
  async listSyncConflicts(): Promise<readonly SyncConflictDto[]> {
    const res = await this.request({
      method: 'GET',
      path: '/sync/conflicts?status=open',
      responseSchema: SyncConflictListResponseSchema,
    });
    return res.conflicts;
  }

  /** T2.6: retry or acknowledge — the only actions; nothing edits data. */
  async resolveSyncConflict(
    id: string,
    action: 'retry' | 'acknowledge',
    note: string,
  ): Promise<ResolveSyncConflictResponseDto> {
    return this.request({
      method: 'POST',
      path: `/sync/conflicts/${encodeURIComponent(id)}/resolve`,
      body: note.trim().length > 0 ? { action, note: note.trim() } : { action },
      responseSchema: ResolveSyncConflictResponseSchema,
    });
  }

  async listUnsettledFiscalDocs(): Promise<readonly FiscalDocDto[]> {
    const res = await this.request({
      method: 'GET',
      path: '/fiscal/docs',
      responseSchema: FiscalUnsettledListResponseSchema,
    });
    return res.docs;
  }

  /** Re-queues a failed document; the hub worker (never the POS) calls the driver. */
  async retryFiscalDoc(docId: string): Promise<FiscalDocDto> {
    const res = await this.request({
      method: 'POST',
      path: `/fiscal/docs/${encodeURIComponent(docId)}/retry`,
      responseSchema: FiscalDocResponseSchema,
    });
    return res.doc;
  }

  async getSaleFiscal(saleId: string) {
    return this.request({
      method: 'GET',
      path: `/sales/${encodeURIComponent(saleId)}/fiscal`,
      responseSchema: SaleFiscalResponseSchema,
    });
  }

  async getTaxProfile(): Promise<TaxProfileResponseDto> {
    return this.request({
      method: 'GET',
      path: '/settings/tax',
      responseSchema: TaxProfileResponseSchema,
    });
  }

  async updateTaxProfile(input: UpdateTaxProfileRequestDto): Promise<TaxProfileResponseDto> {
    return this.request({
      method: 'PUT',
      path: '/settings/tax',
      body: input,
      responseSchema: TaxProfileResponseSchema,
    });
  }

  async scanBarcode(code: string): Promise<ScanBarcodeResponseDto> {
    return this.request({
      method: 'GET',
      path: '/catalog/scan',
      query: { code },
      responseSchema: ScanBarcodeResponseSchema,
    });
  }

  // --- Carts & Sales (`completeSale`) ---

  async getCartSettings(): Promise<CartSettingsResponseDto> {
    return this.request({
      method: 'GET',
      path: '/cart-settings',
      responseSchema: CartSettingsResponseSchema,
    });
  }

  async listCarts(): Promise<ListCartsResponseDto> {
    return this.request({
      method: 'GET',
      path: '/carts',
      responseSchema: ListCartsResponseSchema,
    });
  }

  async createCart(): Promise<CartResponseDto> {
    return this.request({
      method: 'POST',
      path: '/carts',
      body: {},
      responseSchema: CartResponseSchema,
    });
  }

  async getCart(cartId: string): Promise<CartResponseDto> {
    return this.request({
      method: 'GET',
      path: `/carts/${encodeURIComponent(cartId)}`,
      responseSchema: CartResponseSchema,
    });
  }

  async deleteCart(cartId: string): Promise<DeleteCartResponseDto> {
    return this.request({
      method: 'DELETE',
      path: `/carts/${encodeURIComponent(cartId)}`,
      responseSchema: DeleteCartResponseSchema,
    });
  }

  async addCartLine(
    cartId: string,
    input: z.input<typeof AddCartLineRequestSchema>,
  ): Promise<CartResponseDto> {
    const validated: AddCartLineRequestDto = AddCartLineRequestSchema.parse(input);
    return this.request({
      method: 'POST',
      path: `/carts/${encodeURIComponent(cartId)}/lines`,
      body: validated,
      responseSchema: CartResponseSchema,
    });
  }

  async updateCartLine(
    cartId: string,
    lineId: string,
    input: z.input<typeof UpdateCartLineRequestSchema>,
  ): Promise<CartResponseDto> {
    const validated: UpdateCartLineRequestDto = UpdateCartLineRequestSchema.parse(input);
    return this.request({
      method: 'PATCH',
      path: `/carts/${encodeURIComponent(cartId)}/lines/${encodeURIComponent(lineId)}`,
      body: validated,
      responseSchema: CartResponseSchema,
    });
  }

  async removeCartLine(cartId: string, lineId: string): Promise<CartResponseDto> {
    return this.request({
      method: 'DELETE',
      path: `/carts/${encodeURIComponent(cartId)}/lines/${encodeURIComponent(lineId)}`,
      responseSchema: CartResponseSchema,
    });
  }

  async setCartDiscount(
    cartId: string,
    input: z.input<typeof SetCartDiscountRequestSchema>,
  ): Promise<CartResponseDto> {
    const validated: SetCartDiscountRequestDto = SetCartDiscountRequestSchema.parse(input);
    return this.request({
      method: 'PUT',
      path: `/carts/${encodeURIComponent(cartId)}/discount`,
      body: validated,
      responseSchema: CartResponseSchema,
    });
  }

  async refreshCartPrices(cartId: string): Promise<CartResponseDto> {
    return this.request({
      method: 'POST',
      path: `/carts/${encodeURIComponent(cartId)}/refresh-prices`,
      body: {},
      responseSchema: CartResponseSchema,
    });
  }

  async parkCart(
    cartId: string,
    input?: z.input<typeof ParkCartRequestSchema>,
  ): Promise<CartResponseDto> {
    const validated: ParkCartRequestDto = ParkCartRequestSchema.parse(input);
    return this.request({
      method: 'POST',
      path: `/carts/${encodeURIComponent(cartId)}/park`,
      body: validated ?? {},
      responseSchema: CartResponseSchema,
    });
  }

  async resumeCart(cartId: string): Promise<CartResponseDto> {
    return this.request({
      method: 'POST',
      path: `/carts/${encodeURIComponent(cartId)}/resume`,
      body: {},
      responseSchema: CartResponseSchema,
    });
  }

  async completeSale(
    cartId: string,
    input: z.input<typeof CompleteSaleRequestSchema>,
  ): Promise<CompleteSaleResponseDto> {
    const validated: CompleteSaleRequestDto = CompleteSaleRequestSchema.parse(input);
    return this.request({
      method: 'POST',
      path: `/carts/${encodeURIComponent(cartId)}/complete`,
      body: validated,
      responseSchema: CompleteSaleResponseSchema,
    });
  }

  // --- Printer (T1.12) ---

  async getPrinterSettings(): Promise<PrinterSettingsResponseDto> {
    return this.request({
      method: 'GET',
      path: '/printer/settings',
      responseSchema: PrinterSettingsResponseSchema,
    });
  }

  /** Same `clientRequestId` is reused on retry so the hub never prints the receipt twice (P1). */
  // --- C12: receipts history and returns ---

  async listSales(query: {
    readonly q?: string;
    readonly fromMs?: string;
    readonly toMs?: string;
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<ListSalesResponseDto> {
    return this.request({
      method: 'GET',
      path: '/sales',
      query: {
        q: query.q !== undefined && query.q.trim() !== '' ? query.q.trim() : undefined,
        fromMs: query.fromMs,
        toMs: query.toMs,
        limit: query.limit,
        offset: query.offset,
      },
      responseSchema: ListSalesResponseSchema,
    });
  }

  async getSaleReturnContext(saleId: string): Promise<SaleReturnContextResponseDto> {
    return this.request({
      method: 'GET',
      path: `/sales/${encodeURIComponent(saleId)}/return-context`,
      responseSchema: SaleReturnContextResponseSchema,
    });
  }

  async createReturn(
    saleId: string,
    input: z.input<typeof CreateReturnRequestSchema>,
  ): Promise<CreateReturnResponseDto> {
    const validated: CreateReturnRequestDto = CreateReturnRequestSchema.parse(input);
    return this.request({
      method: 'POST',
      path: `/sales/${encodeURIComponent(saleId)}/returns`,
      body: validated,
      responseSchema: CreateReturnResponseSchema,
    });
  }

  async printReturnReceipt(
    returnId: string,
    input: z.input<typeof PrintDocumentRequestSchema>,
  ): Promise<PrintDocumentResponseDto> {
    const validated: PrintDocumentRequestDto = PrintDocumentRequestSchema.parse(input);
    return this.request({
      method: 'POST',
      path: `/returns/${encodeURIComponent(returnId)}/print`,
      body: validated,
      responseSchema: PrintDocumentResponseSchema,
    });
  }

  async printSaleReceipt(
    saleId: string,
    input: z.input<typeof PrintDocumentRequestSchema>,
  ): Promise<PrintDocumentResponseDto> {
    const validated: PrintDocumentRequestDto = PrintDocumentRequestSchema.parse(input);
    return this.request({
      method: 'POST',
      path: `/sales/${encodeURIComponent(saleId)}/print`,
      body: validated,
      responseSchema: PrintDocumentResponseSchema,
    });
  }

  // --- Customers ---

  async listCustomers(query?: CustomerListQueryDto): Promise<CustomerListResponseDto> {
    return this.request({
      method: 'GET',
      path: '/customers',
      query: {
        q: query?.q,
        overdueOnly: query?.overdueOnly,
        includeInactive: query?.includeInactive,
        limit: query?.limit,
        offset: query?.offset,
      },
      responseSchema: CustomerListResponseSchema,
    });
  }

  async createCustomer(
    input: z.input<typeof CreateCustomerRequestSchema>,
  ): Promise<CustomerMutationResponseDto> {
    const validated: CreateCustomerRequestDto = CreateCustomerRequestSchema.parse(input);
    return this.request({
      method: 'POST',
      path: '/customers',
      body: validated,
      responseSchema: CustomerMutationResponseSchema,
    });
  }

  // --- Reports (T1.13) ---

  async getDailySales(query?: DailySalesReportQueryDto): Promise<DailySalesReportResponseDto> {
    return this.request({
      method: 'GET',
      path: '/reports/sales/daily',
      query: {
        fromDate: query?.fromDate,
        toDate: query?.toDate,
        limit: query?.limit,
      },
      responseSchema: DailySalesReportResponseSchema,
    });
  }

  async getMonthlySales(
    query?: MonthlySalesReportQueryDto,
  ): Promise<MonthlySalesReportResponseDto> {
    return this.request({
      method: 'GET',
      path: '/reports/sales/monthly',
      query: {
        year: query?.year,
        limit: query?.limit,
      },
      responseSchema: MonthlySalesReportResponseSchema,
    });
  }

  async getProfitReport(query?: ProfitReportQueryDto): Promise<ProfitReportResponseDto> {
    return this.request({
      method: 'GET',
      path: '/reports/profit',
      query: {
        fromDate: query?.fromDate,
        toDate: query?.toDate,
        groupBy: query?.groupBy,
      },
      responseSchema: ProfitReportResponseSchema,
    });
  }

  async getDebtsReport(query?: DebtsReportQueryDto): Promise<DebtsReportResponseDto> {
    return this.request({
      method: 'GET',
      path: '/reports/debts',
      query: {
        type: query?.type,
      },
      responseSchema: DebtsReportResponseSchema,
    });
  }

  async getLowStock(query?: LowStockReportQueryDto): Promise<LowStockReportResponseDto> {
    return this.request({
      method: 'GET',
      path: '/reports/low-stock',
      query: {
        limit: query?.limit,
      },
      responseSchema: LowStockReportResponseSchema,
    });
  }

  async getExpiringBatches(
    query?: ExpiringBatchesReportQueryDto,
  ): Promise<ExpiringBatchesReportResponseDto> {
    return this.request({
      method: 'GET',
      path: '/reports/expiring-batches',
      query: {
        withinDays: query?.withinDays,
      },
      responseSchema: ExpiringBatchesReportResponseSchema,
    });
  }

  // --- Backups & Restore (T1.13) ---

  async listBackups(): Promise<BackupListResponseDto> {
    return this.request({
      method: 'GET',
      path: '/backups',
      responseSchema: BackupListResponseSchema,
    });
  }

  async createBackup(input?: CreateBackupRequestDto): Promise<CreateBackupResponseDto> {
    const validated = CreateBackupRequestSchema.parse(input ?? {});
    return this.request({
      method: 'POST',
      path: '/backups/create',
      body: validated,
      responseSchema: CreateBackupResponseSchema,
    });
  }

  async stageRestore(
    backupId: string,
    input?: StageRestoreRequestDto,
  ): Promise<StageRestoreResponseDto> {
    const validated = StageRestoreRequestSchema.parse(input ?? {});
    return this.request({
      method: 'POST',
      path: `/backups/${encodeURIComponent(backupId)}/restore`,
      body: validated,
      responseSchema: StageRestoreResponseSchema,
    });
  }

  // --- Catalog Import (T1.13) ---

  async previewCatalogImport(fileBase64: string): Promise<ExcelImportPreviewResponseDto> {
    return this.request({
      method: 'POST',
      path: '/catalog/import/preview',
      body: { fileBase64 },
      responseSchema: ExcelImportPreviewResponseSchema,
    });
  }

  async commitCatalogImport(
    previewToken: string,
    clientRequestId: string,
  ): Promise<ExcelImportCommitResponseDto> {
    const validated: ExcelImportCommitRequestDto = ExcelImportCommitRequestSchema.parse({
      previewToken,
      clientRequestId,
    });
    return this.request({
      method: 'POST',
      path: '/catalog/import/commit',
      body: validated,
      responseSchema: ExcelImportCommitResponseSchema,
    });
  }

  // --- v1 connections: cloud pairing (owner) and LAN terminals (owner/manager) ---

  async getCloudStatus(): Promise<HubCloudStatusDto> {
    return this.request({
      method: 'GET',
      path: '/cloud/status',
      responseSchema: HubCloudStatusSchema,
    });
  }

  async pairCloud(input: { cloudUrl: string; code: string }): Promise<CloudPairResult> {
    const validated = HubPairCloudRequestSchema.parse(input);
    return this.request({
      method: 'POST',
      path: '/cloud/pair',
      body: validated,
      responseSchema: CloudPairResultSchema,
    });
  }

  async unpairCloud(): Promise<void> {
    await this.request({ method: 'POST', path: '/cloud/unpair', responseSchema: z.unknown() });
  }

  async getLanStatus(): Promise<LanStatus> {
    return this.request({ method: 'GET', path: '/lan/status', responseSchema: LanStatusSchema });
  }

  async createLanPairingCode(): Promise<LanPairingCode> {
    return this.request({
      method: 'POST',
      path: '/lan/pairing-codes',
      responseSchema: LanPairingCodeSchema,
    });
  }

  async listLanTerminals(): Promise<readonly LanTerminal[]> {
    const res = await this.request({
      method: 'GET',
      path: '/lan/terminals',
      responseSchema: z.object({ terminals: z.array(LanTerminalSchema) }),
    });
    return res.terminals;
  }

  async revokeLanTerminal(id: string): Promise<void> {
    await this.request({
      method: 'POST',
      path: `/lan/terminals/${encodeURIComponent(id)}/revoke`,
      responseSchema: z.unknown(),
    });
  }
}

const CloudPairResultSchema = z.object({
  status: z.literal('paired'),
  organizationName: z.string(),
  storeName: z.string(),
});
export type CloudPairResult = z.infer<typeof CloudPairResultSchema>;

const LanStatusSchema = z.object({
  fingerprint256: z.string(),
  activeTerminals: z.number().int(),
  port: z.number().int().nullable(),
  addresses: z.array(z.string()),
});
export type LanStatus = z.infer<typeof LanStatusSchema>;

const LanPairingCodeSchema = z.object({
  code: z.string(),
  expiresAtMs: z.string(),
  fingerprint256: z.string(),
  port: z.number().int().nullable(),
  addresses: z.array(z.string()),
});
export type LanPairingCode = z.infer<typeof LanPairingCodeSchema>;

const LanTerminalSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['active', 'revoked']),
  pairedAtMs: z.string(),
  revokedAtMs: z.string().nullable(),
  lastSeenAtMs: z.string().nullable(),
});
export type LanTerminal = z.infer<typeof LanTerminalSchema>;
