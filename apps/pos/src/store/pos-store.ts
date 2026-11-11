import type {
  CartDetailDto,
  CartSummaryDto,
  CategorySummaryDto,
  CompleteSaleResponseDto,
  CustomerSummaryDto,
  LoginOptionDto,
  ProductSummaryDto,
  ShiftClosureDto,
  ShiftDto,
  UserSummaryDto,
} from '@mezon/contracts';
import type { UuidV7 } from '@mezon/domain';
import { create } from 'zustand';
import { generateBrowserUuidV7 } from '../utils/browser-uuid.js';

export type PosTheme = 'light' | 'dark';
export type PosScreen = 'loading' | 'setup' | 'login' | 'open_shift' | 'pos';
export type PosModal =
  | 'none'
  | 'quick_sale'
  | 'discount'
  | 'park_cart'
  | 'parked_list'
  | 'customer'
  | 'shift_manage'
  | 'payment'
  | 'receipt'
  | 'shortcuts'
  | 'edit_qty'
  | 'diagnostics';

export interface InsufficientStockLineDetail {
  readonly cartLineId: string;
  readonly productId: string;
  readonly variantId: string | null;
  readonly itemName: string;
  readonly requestedQty: string;
  readonly availableQty: string;
  readonly deficitQty: string;
}

export interface TotalChangedPrompt {
  readonly expectedTotal: string;
  readonly actualTotal: string;
}

export interface PosStoreState {
  // Bridge & Health
  readonly hubBaseUrl: string | null;
  readonly hubStatus: 'starting' | 'ready' | 'restarting' | 'error';
  readonly hubRestartCount: number;
  readonly healthStatus: string;
  readonly needsSetup: boolean | null;
  readonly healthCheckCount: number;

  // Theme & Navigation
  readonly theme: PosTheme;
  readonly screen: PosScreen;
  readonly activeModal: PosModal;

  // Auth
  readonly token: string | null;
  readonly user: UserSummaryDto | null;
  readonly loginOptions: readonly LoginOptionDto[];
  readonly authRateLimitSeconds: number;

  // Shift
  readonly currentShift: ShiftDto | null;
  readonly drawerCashBalance: string;
  readonly maxCashDiscrepancyWithoutOverride: string;
  readonly lastShiftClosure: ShiftClosureDto | null;

  // Catalog & Search
  readonly categories: readonly CategorySummaryDto[];
  readonly selectedCategoryId: UuidV7 | null;
  readonly searchQuery: string;
  readonly searchResults: readonly ProductSummaryDto[];

  // Cart & Selection
  readonly activeCart: CartDetailDto | null;
  readonly parkedCarts: readonly CartSummaryDto[];
  readonly selectedLineId: UuidV7 | null;
  readonly selectedCustomer: CustomerSummaryDto | null;
  readonly customerList: readonly CustomerSummaryDto[];
  readonly lastScannedBarcode: string | null;
  readonly shortLineIds: ReadonlySet<string>;
  readonly insufficientLines: readonly InsufficientStockLineDetail[];

  // Payment & Idempotency (`clientRequestId`)
  readonly paymentClientRequestId: UuidV7;
  readonly isSubmittingPayment: boolean;
  readonly totalChangedPrompt: TotalChangedPrompt | null;
  readonly lastCompletedSale: CompleteSaleResponseDto | null;

  // Banner / Error
  readonly errorBanner: string | null;

  // Actions
  readonly setBridgeInfo: (info: {
    readonly baseUrl: string | null;
    readonly status: 'starting' | 'ready' | 'restarting' | 'error';
    readonly restartCount: number;
  }) => void;
  readonly setHealthInfo: (info: { readonly status: string; readonly needsSetup: boolean }) => void;
  readonly toggleTheme: () => void;
  readonly setScreen: (screen: PosScreen) => void;
  readonly setActiveModal: (modal: PosModal) => void;
  readonly setLoginOptions: (options: readonly LoginOptionDto[]) => void;
  readonly setAuthenticated: (token: string, user: UserSummaryDto) => void;
  readonly clearSession: () => void;
  readonly setAuthRateLimitSeconds: (seconds: number) => void;
  readonly setShiftState: (info: {
    readonly shift: ShiftDto | null;
    readonly drawerCashBalance: string;
    readonly maxCashDiscrepancyWithoutOverride?: string;
  }) => void;
  readonly setLastShiftClosure: (closure: ShiftClosureDto | null) => void;
  readonly setCategories: (categories: readonly CategorySummaryDto[]) => void;
  readonly setSelectedCategoryId: (categoryId: UuidV7 | null) => void;
  readonly setSearchQuery: (query: string) => void;
  readonly setSearchResults: (products: readonly ProductSummaryDto[]) => void;
  readonly setActiveCart: (cart: CartDetailDto | null) => void;
  readonly setParkedCarts: (carts: readonly CartSummaryDto[]) => void;
  readonly setSelectedLineId: (lineId: UuidV7 | null) => void;
  readonly moveSelectedLine: (delta: -1 | 1) => void;
  readonly setSelectedCustomer: (customer: CustomerSummaryDto | null) => void;
  readonly setCustomerList: (customers: readonly CustomerSummaryDto[]) => void;
  readonly setLastScannedBarcode: (barcode: string | null) => void;
  readonly setInsufficientStockLines: (lines: readonly InsufficientStockLineDetail[]) => void;
  readonly clearInsufficientStockLines: () => void;
  readonly rotatePaymentClientRequestId: () => UuidV7;
  readonly setIsSubmittingPayment: (submitting: boolean) => void;
  readonly setTotalChangedPrompt: (prompt: TotalChangedPrompt | null) => void;
  readonly setLastCompletedSale: (sale: CompleteSaleResponseDto | null) => void;
  readonly setErrorBanner: (message: string | null) => void;
}

export const usePosStore = create<PosStoreState>((set) => ({
  hubBaseUrl: null,
  hubStatus: 'starting',
  hubRestartCount: 0,
  healthStatus: 'pending',
  needsSetup: null,
  healthCheckCount: 0,

  theme: 'light',
  screen: 'loading',
  activeModal: 'none',

  token: null,
  user: null,
  loginOptions: [],
  authRateLimitSeconds: 0,

  currentShift: null,
  drawerCashBalance: '0',
  maxCashDiscrepancyWithoutOverride: '0',
  lastShiftClosure: null,

  categories: [],
  selectedCategoryId: null,
  searchQuery: '',
  searchResults: [],

  activeCart: null,
  parkedCarts: [],
  selectedLineId: null,
  selectedCustomer: null,
  customerList: [],
  lastScannedBarcode: null,
  shortLineIds: new Set<string>(),
  insufficientLines: [],

  paymentClientRequestId: generateBrowserUuidV7(),
  isSubmittingPayment: false,
  totalChangedPrompt: null,
  lastCompletedSale: null,

  errorBanner: null,

  setBridgeInfo: (info) =>
    set({
      hubBaseUrl: info.baseUrl,
      hubStatus: info.status,
      hubRestartCount: info.restartCount,
    }),

  setHealthInfo: (info) =>
    set((state) => ({
      healthStatus: info.status,
      needsSetup: info.needsSetup,
      healthCheckCount: state.healthCheckCount + 1,
    })),

  toggleTheme: () =>
    set((state) => ({
      theme: state.theme === 'light' ? 'dark' : 'light',
    })),

  setScreen: (screen) => set({ screen }),

  setActiveModal: (modal) =>
    set((state) => {
      if (modal === 'payment' && state.activeModal !== 'payment') {
        // Generate a fresh clientRequestId when opening the payment dialog for a new attempt
        return {
          activeModal: modal,
          paymentClientRequestId: generateBrowserUuidV7(),
          totalChangedPrompt: null,
          errorBanner: null,
        };
      }
      return { activeModal: modal, errorBanner: null };
    }),

  setLoginOptions: (options) => set({ loginOptions: options }),

  setAuthenticated: (token, user) =>
    set({
      token,
      user,
      authRateLimitSeconds: 0,
      errorBanner: null,
    }),

  clearSession: () =>
    set({
      token: null,
      user: null,
      currentShift: null,
      activeCart: null,
      parkedCarts: [],
      selectedLineId: null,
      selectedCustomer: null,
      activeModal: 'none',
      screen: 'login',
      errorBanner: null,
    }),

  setAuthRateLimitSeconds: (seconds) => set({ authRateLimitSeconds: seconds }),

  setShiftState: (info) =>
    set((state) => ({
      currentShift: info.shift,
      drawerCashBalance: info.drawerCashBalance,
      maxCashDiscrepancyWithoutOverride:
        info.maxCashDiscrepancyWithoutOverride ?? state.maxCashDiscrepancyWithoutOverride,
    })),

  setLastShiftClosure: (closure) => set({ lastShiftClosure: closure }),

  setCategories: (categories) => set({ categories }),

  setSelectedCategoryId: (categoryId) => set({ selectedCategoryId: categoryId }),

  setSearchQuery: (query) => set({ searchQuery: query }),

  setSearchResults: (products) => set({ searchResults: products }),

  setActiveCart: (cart) =>
    set((state) => {
      const lines = cart?.lines ?? [];
      const currentSelected = state.selectedLineId;
      const stillExists =
        currentSelected !== null && lines.some((line) => line.id === currentSelected);
      const nextSelected = stillExists ? currentSelected : (lines[lines.length - 1]?.id ?? null);
      return {
        activeCart: cart,
        selectedLineId: nextSelected,
      };
    }),

  setParkedCarts: (carts) => set({ parkedCarts: carts }),

  setSelectedLineId: (lineId) => set({ selectedLineId: lineId }),

  moveSelectedLine: (delta) =>
    set((state) => {
      const lines = state.activeCart?.lines ?? [];
      if (lines.length === 0) {
        return { selectedLineId: null };
      }
      const idx = lines.findIndex((l) => l.id === state.selectedLineId);
      if (idx === -1) {
        return { selectedLineId: lines[0]?.id ?? null };
      }
      const nextIdx = Math.max(0, Math.min(lines.length - 1, idx + delta));
      return { selectedLineId: lines[nextIdx]?.id ?? null };
    }),

  setSelectedCustomer: (customer) => set({ selectedCustomer: customer }),

  setCustomerList: (customers) => set({ customerList: customers }),

  setLastScannedBarcode: (barcode) => set({ lastScannedBarcode: barcode }),

  setInsufficientStockLines: (lines) =>
    set({
      insufficientLines: lines,
      shortLineIds: new Set(lines.map((l) => l.cartLineId)),
    }),

  clearInsufficientStockLines: () =>
    set({
      insufficientLines: [],
      shortLineIds: new Set<string>(),
    }),

  rotatePaymentClientRequestId: () => {
    const nextId = generateBrowserUuidV7();
    set({ paymentClientRequestId: nextId });
    return nextId;
  },

  setIsSubmittingPayment: (submitting) => set({ isSubmittingPayment: submitting }),

  setTotalChangedPrompt: (prompt) => set({ totalChangedPrompt: prompt }),

  setLastCompletedSale: (sale) => set({ lastCompletedSale: sale }),

  setErrorBanner: (message) => set({ errorBanner: message }),
}));
