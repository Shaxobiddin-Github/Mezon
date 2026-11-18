import type {
  AdminCustomerDetailResponseDto,
  AdminCustomersQueryDto,
  AdminCustomersResponseDto,
  AdminDashboardResponseDto,
  AdminReceiptDetailResponseDto,
  AdminReceiptsQueryDto,
  AdminReceiptsResponseDto,
  CloudLoginRequestDto,
  DailySalesReportQueryDto,
  DailySalesReportResponseDto,
} from '@mezon/contracts';

export interface AdminUser {
  readonly id: string;
  readonly organizationId: string;
  readonly role: 'owner' | 'manager';
  readonly name: string;
}

/** API failure with the HTTP status, so the UI can show a localized message (T2.7a R3). */
export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

export class AdminApiClient {
  private accessToken: string | null = null;
  private onUnauthorized: (() => void) | null = null;

  setAccessToken(token: string | null) {
    this.accessToken = token;
  }

  setOnUnauthorized(callback: () => void) {
    this.onUnauthorized = callback;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    retryOn401 = true,
  ): Promise<T> {
    const headers = new Headers(options.headers ?? {});
    headers.set('Accept', 'application/json');

    if (this.accessToken && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${this.accessToken}`);
    }

    const res = await fetch(endpoint, {
      ...options,
      headers,
      credentials: 'include',
    });

    if (res.status === 401 && retryOn401 && endpoint !== '/api/v1/admin/auth/login') {
      try {
        const refreshed = await this.refresh();
        this.accessToken = refreshed.accessToken;
        headers.set('Authorization', `Bearer ${this.accessToken}`);
        return this.request<T>(endpoint, { ...options, headers }, false);
      } catch {
        this.accessToken = null;
        this.onUnauthorized?.();
        throw new AdminApiError(401, 'Sessiya muddati tugadi. Iltimos, qaytadan kiring.');
      }
    }

    if (!res.ok) {
      let errMsg = `Server xatosi: ${res.status}`;
      try {
        const errJson = (await res.json()) as { message?: string; error?: string };
        errMsg = errJson.message ?? errJson.error ?? errMsg;
      } catch {
        // ignore
      }
      throw new AdminApiError(res.status, errMsg);
    }

    return res.json() as Promise<T>;
  }

  async login(payload: CloudLoginRequestDto): Promise<{ accessToken: string; user: AdminUser }> {
    const res = await this.request<{ accessToken: string; user: AdminUser }>(
      '/api/v1/admin/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      false,
    );
    this.accessToken = res.accessToken;
    return res;
  }

  async refresh(): Promise<{ accessToken: string }> {
    const res = await fetch('/api/v1/admin/auth/refresh', {
      method: 'POST',
      headers: {
        'X-Mezon-Admin': '1', // A3 CSRF guard
        Accept: 'application/json',
      },
      credentials: 'include',
    });

    if (!res.ok) {
      throw new Error('Refresh failed');
    }

    const data = (await res.json()) as { accessToken: string };
    this.accessToken = data.accessToken;
    return data;
  }

  async logout(): Promise<void> {
    try {
      await fetch('/api/v1/admin/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Mezon-Admin': '1' }, // A3 CSRF guard
      });
    } finally {
      this.accessToken = null;
    }
  }

  async getDashboard(params?: {
    storeId?: string;
    tz?: string;
  }): Promise<AdminDashboardResponseDto> {
    const query = new URLSearchParams();
    if (params?.storeId) query.set('storeId', params.storeId);
    if (params?.tz) query.set('tz', params.tz);
    const qs = query.toString() ? `?${query.toString()}` : '';
    return this.request<AdminDashboardResponseDto>(`/api/v1/admin/dashboard${qs}`);
  }

  async getReceipts(params?: AdminReceiptsQueryDto): Promise<AdminReceiptsResponseDto> {
    const query = new URLSearchParams();
    if (params?.storeId) query.set('storeId', params.storeId);
    if (params?.status) query.set('status', params.status);
    if (params?.cursor) query.set('cursor', params.cursor);
    if (params?.limit) query.set('limit', params.limit.toString());
    const qs = query.toString() ? `?${query.toString()}` : '';
    return this.request<AdminReceiptsResponseDto>(`/api/v1/admin/receipts${qs}`);
  }

  async getReceiptDetail(receiptId: string): Promise<AdminReceiptDetailResponseDto> {
    return this.request<AdminReceiptDetailResponseDto>(`/api/v1/admin/receipts/${receiptId}`);
  }

  async getCustomers(params?: AdminCustomersQueryDto): Promise<AdminCustomersResponseDto> {
    const query = new URLSearchParams();
    if (params?.search) query.set('search', params.search);
    if (params?.cursor) query.set('cursor', params.cursor);
    if (params?.limit) query.set('limit', params.limit.toString());
    const qs = query.toString() ? `?${query.toString()}` : '';
    return this.request<AdminCustomersResponseDto>(`/api/v1/admin/customers${qs}`);
  }

  async getCustomerDetail(customerId: string): Promise<AdminCustomerDetailResponseDto> {
    return this.request<AdminCustomerDetailResponseDto>(`/api/v1/admin/customers/${customerId}`);
  }

  async getDailySalesReport(
    params?: DailySalesReportQueryDto,
  ): Promise<DailySalesReportResponseDto> {
    const query = new URLSearchParams();
    if (params?.fromDate) query.set('fromDate', params.fromDate);
    if (params?.toDate) query.set('toDate', params.toDate);
    if (params?.limit) query.set('limit', params.limit.toString());
    const qs = query.toString() ? `?${query.toString()}` : '';
    return this.request<DailySalesReportResponseDto>(`/api/v1/admin/reports/daily${qs}`);
  }

  // T2.8 Telegram
  async getTelegramStatus(): Promise<TelegramStatus> {
    return this.request<TelegramStatus>('/api/v1/admin/telegram/status');
  }

  async createTelegramLink(): Promise<TelegramLink> {
    return this.request<TelegramLink>('/api/v1/admin/telegram/link', { method: 'POST' });
  }

  async deleteTelegramLink(): Promise<void> {
    await this.request<unknown>('/api/v1/admin/telegram/link', { method: 'DELETE' });
  }

  async createCustomerTelegramLink(customerId: string): Promise<TelegramLink> {
    return this.request<TelegramLink>(
      `/api/v1/admin/customers/${encodeURIComponent(customerId)}/telegram-link`,
      { method: 'POST' },
    );
  }
}

export interface TelegramStatus {
  readonly enabled: boolean;
  readonly linked: boolean;
  readonly linkedAtMs: string | null;
}

export interface TelegramLink {
  readonly code: string;
  /** Null when the bot username is not configured. */
  readonly url: string | null;
  readonly expiresAtMs: string;
}

export const adminApi = new AdminApiClient();
