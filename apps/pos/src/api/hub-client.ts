import {
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
} from '@mezon/contracts';
import type { z } from 'zod';
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

  async listProducts(query: ListProductsQueryDto): Promise<ListProductsResponseDto> {
    return this.request({
      method: 'GET',
      path: '/products',
      query: {
        q: query.q,
        categoryId: query.categoryId,
        limit: query.limit,
        offset: query.offset,
      },
      responseSchema: ListProductsResponseSchema,
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
}
