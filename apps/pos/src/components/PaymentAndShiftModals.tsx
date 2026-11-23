import type { IntegrationsStatusResponse, SalePaymentInputDto } from '@mezon/contracts';
import type { ShiftExpenseCategory } from '@mezon/domain';
import { t } from '@mezon/i18n';
import {
  formatMilliToQtyString,
  formatTiyinToSom,
  parseSomInputToTiyinString,
  tiyinToSomInputString,
} from '@mezon/ui';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ReceiptFiscalBadge } from './FiscalPanels.js';
import { Icon } from './Icon.js';
import { QrPayPanel } from './QrPayPanel.js';
import { RulesPanel } from './RulesPanel.js';
import { type HubApiClient, HubApiError } from '../api/hub-client.js';
import {
  type InsufficientStockLineDetail,
  type PaidQrPayment,
  usePosStore,
} from '../store/pos-store.js';
import { generateBrowserUuidV7 } from '../utils/browser-uuid.js';

type NonCashMethod = 'card' | 'uzqr' | 'payme' | 'click' | 'uzum' | 'social_card' | 'other';

/**
 * Non-cash payments recorded by hand. UzQR is not in this list: a UzQR payment closes a receipt only
 * with a provider-confirmed QR, so it has its own button and screen (`QrPayPanel`, V2).
 */
export const NON_CASH_METHODS: readonly NonCashMethod[] = [
  'card',
  'payme',
  'click',
  'uzum',
  'social_card',
  'other',
];

const NO_PAID_QR: readonly PaidQrPayment[] = [];

const EXPENSE_CATEGORIES: readonly ShiftExpenseCategory[] = [
  'supplies',
  'transport',
  'utilities',
  'salary_advance',
  'repair',
  'other',
];

interface NonCashRowState {
  readonly key: string;
  readonly method: NonCashMethod;
  readonly amountSom: string;
  readonly providerRef: string;
}

export function PaymentModal({
  api,
  onSaleCompleted,
  onError,
}: {
  readonly api: HubApiClient;
  readonly onSaleCompleted: () => Promise<void>;
  readonly onError: (err: unknown) => void;
}) {
  const activeCart = usePosStore((s) => s.activeCart);
  const setActiveCart = usePosStore((s) => s.setActiveCart);
  const selectedCustomer = usePosStore((s) => s.selectedCustomer);
  const paymentClientRequestId = usePosStore((s) => s.paymentClientRequestId);
  const rotatePaymentClientRequestId = usePosStore((s) => s.rotatePaymentClientRequestId);
  const isSubmittingPayment = usePosStore((s) => s.isSubmittingPayment);
  const setIsSubmittingPayment = usePosStore((s) => s.setIsSubmittingPayment);
  const totalChangedPrompt = usePosStore((s) => s.totalChangedPrompt);
  const setTotalChangedPrompt = usePosStore((s) => s.setTotalChangedPrompt);
  const setLastCompletedSale = usePosStore((s) => s.setLastCompletedSale);
  const setActiveModal = usePosStore((s) => s.setActiveModal);
  const setInsufficientStockLines = usePosStore((s) => s.setInsufficientStockLines);
  const clearInsufficientStockLines = usePosStore((s) => s.clearInsufficientStockLines);
  const setErrorBanner = usePosStore((s) => s.setErrorBanner);
  const paidQr = usePosStore((s) => s.paidQrByCart[activeCart?.id ?? ''] ?? NO_PAID_QR);
  const addPaidQr = usePosStore((s) => s.addPaidQr);
  const clearPaidQr = usePosStore((s) => s.clearPaidQr);
  const [integrations, setIntegrations] = useState<IntegrationsStatusResponse | null>(null);
  const [qrAmountTiyin, setQrAmountTiyin] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.getIntegrations().then(
      (st) => {
        if (alive) setIntegrations(st);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const initialTotalTiyin = activeCart?.totalFinal ?? '0';
  const [expectedTotalTiyin, setExpectedTotalTiyin] = useState(initialTotalTiyin);
  const [tenderedCashSom, setTenderedCashSom] = useState(tiyinToSomInputString(initialTotalTiyin));
  const [nonCashRows, setNonCashRows] = useState<readonly NonCashRowState[]>([]);
  const [debtSom, setDebtSom] = useState('0');
  const [dueDaysStr, setDueDaysStr] = useState('30');
  const [needsCreditOverride, setNeedsCreditOverride] = useState(false);
  const [supervisorUsername, setSupervisorUsername] = useState('');
  const [supervisorPin, setSupervisorPin] = useState('');
  const [networkRetryPending, setNetworkRetryPending] = useState(false);
  const [rulesBlocked, setRulesBlocked] = useState(false);

  if (!activeCart) {
    return null;
  }

  let totalTiyin = 0n;
  try {
    totalTiyin = BigInt(expectedTotalTiyin);
  } catch {
    totalTiyin = 0n;
  }

  let debtTiyin = 0n;
  try {
    debtTiyin = debtSom.trim().length > 0 ? BigInt(parseSomInputToTiyinString(debtSom)) : 0n;
  } catch {
    debtTiyin = 0n;
  }

  let nonCashSumTiyin = 0n;
  for (const qr of paidQr) nonCashSumTiyin += BigInt(qr.amountTiyin);
  for (const row of nonCashRows) {
    try {
      if (row.amountSom.trim().length > 0) {
        nonCashSumTiyin += BigInt(parseSomInputToTiyinString(row.amountSom));
      }
    } catch {
      // ignore invalid partial typing
    }
  }

  let tenderedCashTiyin = 0n;
  try {
    tenderedCashTiyin =
      tenderedCashSom.trim().length > 0 ? BigInt(parseSomInputToTiyinString(tenderedCashSom)) : 0n;
  } catch {
    tenderedCashTiyin = 0n;
  }

  const remainingForCashTiyin =
    totalTiyin > nonCashSumTiyin + debtTiyin ? totalTiyin - nonCashSumTiyin - debtTiyin : 0n;

  const cashAppliedTiyin =
    tenderedCashTiyin >= remainingForCashTiyin ? remainingForCashTiyin : tenderedCashTiyin;
  const changeDueTiyin =
    tenderedCashTiyin > cashAppliedTiyin ? tenderedCashTiyin - cashAppliedTiyin : 0n;
  const unallocatedTiyin = totalTiyin - (cashAppliedTiyin + nonCashSumTiyin + debtTiyin);

  // A real provider, or the test one while the owner's demo mode is on.
  const qrAvailable =
    integrations !== null && (integrations.demoMode || !integrations.payment.isTestDriver);

  const onInputsChanged = () => {
    if (networkRetryPending) {
      setNetworkRetryPending(false);
      rotatePaymentClientRequestId();
    }
  };

  const buildPayments = (): SalePaymentInputDto[] => {
    const out: SalePaymentInputDto[] = [];
    if (cashAppliedTiyin > 0n && tenderedCashTiyin > 0n) {
      out.push({
        method: 'cash',
        tenderedAmount: tenderedCashTiyin.toString(),
        amount: cashAppliedTiyin.toString(),
      });
    }
    for (const qr of paidQr) {
      out.push({ method: 'uzqr', amount: qr.amountTiyin, providerRef: qr.providerRef });
    }
    for (const row of nonCashRows) {
      let amt: string;
      try {
        amt = row.amountSom.trim().length > 0 ? parseSomInputToTiyinString(row.amountSom) : '0';
      } catch {
        continue;
      }
      if (BigInt(amt) > 0n) {
        out.push({
          method: row.method,
          amount: amt,
          providerRef: row.providerRef.trim() || null,
        });
      }
    }
    return out;
  };

  const submitSale = async (overrideTotalTiyin?: string) => {
    if (isSubmittingPayment) {
      return;
    }
    const targetExpectedTotal = overrideTotalTiyin ?? expectedTotalTiyin;
    setIsSubmittingPayment(true);
    setErrorBanner(null);

    try {
      const payments = buildPayments();

      const creditOverride =
        needsCreditOverride && supervisorUsername.trim().length > 0
          ? { username: supervisorUsername.trim(), pin: supervisorPin }
          : undefined;

      const parsedDueDays =
        debtTiyin > 0n && dueDaysStr.trim().length > 0 ? Number(dueDaysStr.trim()) : undefined;

      const res = await api.completeSale(activeCart.id, {
        clientRequestId: paymentClientRequestId,
        expectedTotal: targetExpectedTotal,
        debtAmount: debtTiyin > 0n ? debtTiyin.toString() : undefined,
        customerId: selectedCustomer?.id ?? null,
        dueDays: parsedDueDays,
        creditOverride,
        payments,
      });

      clearInsufficientStockLines();
      clearPaidQr(activeCart.id);
      setNetworkRetryPending(false);
      setTotalChangedPrompt(null);
      setLastCompletedSale(res);
      rotatePaymentClientRequestId();
      await onSaleCompleted();
      setActiveModal('receipt');
    } catch (err) {
      if (err instanceof HubApiError) {
        if (err.isNetworkError) {
          setNetworkRetryPending(true);
          setErrorBanner(t('error.network'));
          return;
        }
        if (err.code === 'SALE_TOTAL_CHANGED') {
          const refreshed = await api.getCart(activeCart.id);
          setActiveCart(refreshed.cart);
          setTotalChangedPrompt({
            expectedTotal: targetExpectedTotal,
            actualTotal: refreshed.cart.totalFinal,
          });
          return;
        }
        if (err.code === 'CREDIT_LIMIT_EXCEEDED') {
          setNeedsCreditOverride(true);
          setErrorBanner(t('error.CREDIT_LIMIT_EXCEEDED'));
          return;
        }
        if (err.code === 'RULES_BLOCKED') {
          setRulesBlocked(true);
          setErrorBanner(t('error.RULES_BLOCKED'));
          return;
        }
        if (err.code === 'INSUFFICIENT_STOCK') {
          const rawShort = err.details?.['insufficientLines'];
          if (Array.isArray(rawShort)) {
            setInsufficientStockLines(rawShort as InsufficientStockLineDetail[]);
          }
          setErrorBanner(t('error.INSUFFICIENT_STOCK'));
          return;
        }
      }
      onError(err);
    } finally {
      setIsSubmittingPayment(false);
    }
  };

  const handleFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submitSale();
  };

  const handleAcceptNewTotal = () => {
    if (!totalChangedPrompt) {
      return;
    }
    const nextTotal = totalChangedPrompt.actualTotal;
    setExpectedTotalTiyin(nextTotal);
    setTenderedCashSom(tiyinToSomInputString(nextTotal));
    setTotalChangedPrompt(null);
    rotatePaymentClientRequestId();
  };

  return (
    <div className="pos-modal-backdrop" data-testid="payment-modal">
      <form className="pos-modal-card pos-pay-card" onSubmit={handleFormSubmit}>
        <div className="pos-modal-header">
          <h3 className="pos-modal-title pos-title-icon">
            <Icon name="wallet" />
            {t('payment.title')}
          </h3>
          <button
            type="button"
            className="pos-btn pos-modal-close"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={() => setActiveModal('none')}
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="pos-pay-grid">
          <div className="pos-pay-main">
            {totalChangedPrompt && (
              <div className="pos-error-banner" data-testid="sale-total-changed-box">
                <span>
                  {t('payment.totalChangedConfirm', {
                    oldTotal: `${formatTiyinToSom(totalChangedPrompt.expectedTotal)} ${t('common.currency')}`,
                    newTotal: `${formatTiyinToSom(totalChangedPrompt.actualTotal)} ${t('common.currency')}`,
                  })}
                </span>
                <button
                  type="button"
                  className="pos-btn pos-btn-primary"
                  data-testid="accept-new-total-btn"
                  onClick={handleAcceptNewTotal}
                >
                  {t('payment.acceptNewTotalBtn')}
                </button>
              </div>
            )}

            <div className="pos-form-group">
              <label className="pos-form-label pos-label-icon" htmlFor="pay-tendered-cash">
                <Icon name="cash" />
                {t('payment.tenderedCash')}
              </label>
              <input
                id="pay-tendered-cash"
                className="pos-input pos-input-money"
                inputMode="numeric"
                data-testid="payment-tendered-cash-input"
                value={tenderedCashSom}
                onChange={(e) => {
                  onInputsChanged();
                  setTenderedCashSom(e.target.value);
                }}
                autoFocus
              />
              <div className="pos-cash-grid">
                <button
                  type="button"
                  className="pos-btn pos-btn-secondary"
                  data-testid="payment-exact-cash-btn"
                  onClick={() => {
                    onInputsChanged();
                    setTenderedCashSom(tiyinToSomInputString(remainingForCashTiyin.toString()));
                  }}
                >
                  <Icon name="check" />
                  {t('payment.exactCashBtn')}
                </button>
                {['10000', '20000', '50000', '100000', '200000'].map((som) => (
                  <button
                    key={som}
                    type="button"
                    className="pos-btn"
                    data-testid={`payment-quick-cash-${som}`}
                    onClick={() => {
                      onInputsChanged();
                      setTenderedCashSom(som);
                    }}
                  >
                    {formatTiyinToSom((BigInt(som) * 100n).toString())}
                  </button>
                ))}
              </div>
            </div>

            {qrAmountTiyin !== null && (
              <QrPayPanel
                api={api}
                cartId={activeCart.id}
                amountTiyin={qrAmountTiyin}
                onError={onError}
                onClose={() => setQrAmountTiyin(null)}
                onPaid={(intent) => {
                  onInputsChanged();
                  const paid: PaidQrPayment = {
                    intentId: intent.id,
                    providerRef: intent.providerRef,
                    amountTiyin: intent.amount,
                    isTestDriver: intent.isTestDriver,
                  };
                  addPaidQr(activeCart.id, paid);
                  const left = remainingForCashTiyin - BigInt(intent.amount);
                  setTenderedCashSom(tiyinToSomInputString((left > 0n ? left : 0n).toString()));
                  setQrAmountTiyin(null);
                }}
              />
            )}

            <div className="pos-method-row">
              {qrAvailable && qrAmountTiyin === null && remainingForCashTiyin > 0n && (
                <button
                  type="button"
                  className="pos-btn pos-method-btn pos-method-qr"
                  data-testid="payment-qr-btn"
                  onClick={() => setQrAmountTiyin(remainingForCashTiyin.toString())}
                >
                  <Icon name="qr" />
                  {t('payment.qr.button')}
                </button>
              )}
              <button
                type="button"
                className="pos-btn pos-method-btn"
                data-testid="payment-add-noncash-btn"
                onClick={() => {
                  onInputsChanged();
                  setNonCashRows((rows) => [
                    ...rows,
                    {
                      key: generateBrowserUuidV7(),
                      method: 'card',
                      amountSom: tiyinToSomInputString(remainingForCashTiyin.toString()),
                      providerRef: '',
                    },
                  ]);
                  setTenderedCashSom('0');
                }}
              >
                <Icon name="card" />
                {t('payment.addNonCashBtn')}
              </button>
            </div>
            <div className="pos-noncash-list">
              {nonCashRows.map((row, index) => (
                <div
                  key={row.key}
                  className="pos-noncash-row"
                  data-testid={`payment-noncash-row-${String(index)}`}
                >
                  <select
                    className="pos-select"
                    data-testid={`payment-noncash-method-${String(index)}`}
                    value={row.method}
                    onChange={(e) => {
                      onInputsChanged();
                      const nextMethod = e.target.value as NonCashMethod;
                      setNonCashRows((prev) =>
                        prev.map((r) => (r.key === row.key ? { ...r, method: nextMethod } : r)),
                      );
                    }}
                  >
                    {NON_CASH_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {t(`payment.method.${m}`)}
                      </option>
                    ))}
                  </select>
                  <input
                    className="pos-input"
                    data-testid={`payment-noncash-amount-${String(index)}`}
                    value={row.amountSom}
                    onChange={(e) => {
                      onInputsChanged();
                      const val = e.target.value;
                      setNonCashRows((prev) =>
                        prev.map((r) => (r.key === row.key ? { ...r, amountSom: val } : r)),
                      );
                    }}
                  />
                  <input
                    className="pos-input"
                    data-testid={`payment-noncash-ref-${String(index)}`}
                    placeholder={t('payment.providerRefPlaceholder')}
                    value={row.providerRef}
                    onChange={(e) => {
                      onInputsChanged();
                      const val = e.target.value;
                      setNonCashRows((prev) =>
                        prev.map((r) => (r.key === row.key ? { ...r, providerRef: val } : r)),
                      );
                    }}
                  />
                  <button
                    type="button"
                    className="pos-btn pos-btn-danger-soft"
                    aria-label={t('common.delete')}
                    title={t('common.delete')}
                    onClick={() => {
                      onInputsChanged();
                      setNonCashRows((prev) => prev.filter((r) => r.key !== row.key));
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              ))}
            </div>

            <div className="pos-form-group">
              <label className="pos-form-label pos-label-icon" htmlFor="pay-debt-som">
                <Icon name="debt" />
                {t('payment.debtAmount')} {selectedCustomer ? `(${selectedCustomer.fullName})` : ''}
              </label>
              <div className="pos-search-bar">
                <input
                  id="pay-debt-som"
                  className="pos-input"
                  inputMode="numeric"
                  data-testid="payment-debt-input"
                  value={debtSom}
                  onChange={(e) => {
                    onInputsChanged();
                    setDebtSom(e.target.value);
                  }}
                />
                {debtTiyin > 0n && (
                  <input
                    className="pos-input"
                    data-testid="payment-due-days-input"
                    placeholder={t('payment.dueDays')}
                    value={dueDaysStr}
                    onChange={(e) => {
                      onInputsChanged();
                      setDueDaysStr(e.target.value);
                    }}
                  />
                )}
              </div>
            </div>

            {needsCreditOverride && (
              <div className="pos-pane" data-testid="payment-credit-override-box">
                <strong>{t('supervisor.title')}</strong>
                <input
                  className="pos-input"
                  data-testid="payment-supervisor-username"
                  placeholder={t('supervisor.username')}
                  value={supervisorUsername}
                  onChange={(e) => setSupervisorUsername(e.target.value)}
                />
                <input
                  type="password"
                  className="pos-input"
                  data-testid="payment-supervisor-pin"
                  placeholder={t('supervisor.pin')}
                  value={supervisorPin}
                  onChange={(e) => setSupervisorPin(e.target.value)}
                />
              </div>
            )}
          </div>

          <aside className="pos-pay-aside">
            <div className="pos-pay-hero" data-testid="payment-total-display">
              <span>{t('payment.totalToPay')}:</span>
              <span>
                {formatTiyinToSom(expectedTotalTiyin)} {t('common.currency')}
              </span>
            </div>
            <div className="pos-totals-box">
              <div className="pos-totals-row">
                <span>{t('payment.cashApplied')}:</span>
                <strong data-testid="payment-cash-applied">
                  {formatTiyinToSom(cashAppliedTiyin)} {t('common.currency')}
                </strong>
              </div>
              <div
                className={`pos-totals-row pos-change-row ${changeDueTiyin > 0n ? 'pos-change-due' : ''}`}
              >
                <span>{t('payment.changeDue')}:</span>
                <strong data-testid="payment-change-due">
                  {formatTiyinToSom(changeDueTiyin)} {t('common.currency')}
                </strong>
              </div>
            </div>

            {paidQr.length > 0 && (
              <div className="pos-qr-paid-list" data-testid="payment-qr-paid-list">
                {paidQr.map((qr) => (
                  <div key={qr.intentId} className="pos-qr-paid-row">
                    <span className="pos-qr-paid-ok" aria-hidden="true">
                      <Icon name="check" />
                    </span>
                    <span>
                      {t('payment.method.uzqr')} · {formatTiyinToSom(qr.amountTiyin)}{' '}
                      {t('common.currency')}
                    </span>
                    <small>
                      {qr.isTestDriver ? `${t('payment.qr.testShort')} · ` : ''}
                      {qr.providerRef}
                    </small>
                  </div>
                ))}
              </div>
            )}

            <RulesPanel
              api={api}
              cartId={activeCart.id}
              cartVersionKey={`${activeCart.id}:${activeCart.totalFinal}:${String(activeCart.lines.length)}`}
              payments={buildPayments()}
              onBlockedChange={setRulesBlocked}
            />

            <div className="pos-totals-row">
              <span>{t('payment.remainingUnallocated')}:</span>
              <strong data-testid="payment-unallocated">
                {formatTiyinToSom(unallocatedTiyin)} {t('common.currency')}
              </strong>
            </div>

            <div className="pos-pay-submit">
              <button
                type="submit"
                className="pos-btn pos-btn-success pos-btn-xl"
                data-testid="payment-complete-btn"
                disabled={isSubmittingPayment || unallocatedTiyin !== 0n || rulesBlocked}
              >
                <Icon name="check" />
                {isSubmittingPayment ? t('payment.submitting') : t('payment.completeBtn')}
              </button>
              {networkRetryPending && (
                <button
                  type="button"
                  className="pos-btn pos-btn-primary"
                  data-testid="payment-retry-btn"
                  disabled={isSubmittingPayment}
                  onClick={() => void submitSale()}
                >
                  <Icon name="refresh" />
                  {t('common.retry')}
                </button>
              )}
            </div>
          </aside>
        </div>
      </form>
    </div>
  );
}

type PrintUiState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'printing' }
  | { readonly kind: 'printed'; readonly copyNumber: number }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * T1.12 P3: the receipt modal never waits for the printer. Auto-print runs in the background and the
 * cashier can start the next sale immediately. P1: one `clientRequestId` per print attempt, reused on
 * network retry so the hub never prints the same request twice.
 */
export function ReceiptModal({ api }: { readonly api?: HubApiClient } = {}) {
  const lastCompletedSale = usePosStore((s) => s.lastCompletedSale);
  const setActiveModal = usePosStore((s) => s.setActiveModal);
  const [printState, setPrintState] = useState<PrintUiState>({ kind: 'idle' });
  const autoPrintedFor = useRef<string | null>(null);
  const pendingReprintId = useRef<string | null>(null);
  const saleId = lastCompletedSale?.sale.id ?? null;

  const runPrint = async (clientRequestId: string, reprint: boolean): Promise<boolean> => {
    if (!api || saleId === null) return false;
    setPrintState({ kind: 'printing' });
    try {
      const res = await api.printSaleReceipt(saleId, { clientRequestId, reprint });
      const rec = res.printRecord;
      if (rec.status === 'printed') {
        setPrintState({ kind: 'printed', copyNumber: rec.copyNumber });
      } else if (rec.status === 'disabled') {
        setPrintState({ kind: 'disabled' });
      } else {
        setPrintState({ kind: 'failed', message: rec.errorMessage ?? rec.errorCode ?? '' });
      }
      return true;
    } catch (err) {
      const message = err instanceof HubApiError ? err.message : String(err);
      setPrintState({ kind: 'failed', message });
      // Network error: keep the same id so a retry is idempotent.
      return !(err instanceof HubApiError && err.isNetworkError);
    }
  };

  useEffect(() => {
    if (!api || saleId === null || autoPrintedFor.current === saleId) return;
    autoPrintedFor.current = saleId;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await api.getPrinterSettings();
        if (cancelled || !settings.settings.autoPrintSale) return;
        await runPrint(generateBrowserUuidV7(), false);
      } catch {
        /* printer problems never block the sale */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, saleId]);

  if (!lastCompletedSale) {
    return null;
  }

  const { sale } = lastCompletedSale;

  const onReprint = async () => {
    if (printState.kind === 'printing') return;
    const id = pendingReprintId.current ?? generateBrowserUuidV7();
    pendingReprintId.current = id;
    const settled = await runPrint(id, true);
    if (settled) pendingReprintId.current = null;
  };

  return (
    <div className="pos-modal-backdrop" data-testid="receipt-modal">
      <div className="pos-modal-card">
        <div className="pos-non-fiscal-banner" data-testid="receipt-non-fiscal-banner">
          {t('receipt.nonFiscalBanner')}
        </div>

        <div className="pos-modal-header">
          <h3 className="pos-modal-title pos-title-icon">
            <Icon name="receipts" />
            {t('receipt.title')}
          </h3>
          <span data-testid="receipt-code">{sale.receiptCode}</span>
        </div>

        {api && <ReceiptFiscalBadge api={api} saleId={sale.id} />}

        <div className="pos-totals-row">
          <span>{t('receipt.receiptNo')}:</span>
          <strong data-testid="receipt-no">{sale.receiptNo}</strong>
        </div>

        <table className="pos-cart-table">
          <thead>
            <tr>
              <th>{t('pos.colItem')}</th>
              <th>{t('pos.colQty')}</th>
              <th>{t('pos.colPrice')}</th>
              <th>{t('pos.colTotal')}</th>
            </tr>
          </thead>
          <tbody>
            {sale.lines.map((line) => (
              <tr key={line.id} data-testid={`receipt-line-${line.id}`}>
                <td>{line.itemName}</td>
                <td>
                  {formatMilliToQtyString(line.qty)} {t(`unit.${line.unit}`)}
                </td>
                <td>{formatTiyinToSom(line.unitPriceSnapshot)}</td>
                <td>{formatTiyinToSom(line.finalTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="pos-totals-box">
          <div className="pos-totals-grand">
            <span>{t('pos.totalPayable')}:</span>
            <span data-testid="receipt-total-final">
              {formatTiyinToSom(sale.totalFinal)} {t('common.currency')}
            </span>
          </div>
          <div className="pos-totals-row">
            <span>{t('receipt.totalPaid')}:</span>
            <span data-testid="receipt-total-paid">
              {formatTiyinToSom(sale.totalPaid)} {t('common.currency')}
            </span>
          </div>
          <div className="pos-totals-row">
            <span>{t('receipt.changeAmount')}:</span>
            <span data-testid="receipt-change-amount">
              {formatTiyinToSom(sale.changeAmount)} {t('common.currency')}
            </span>
          </div>
          {BigInt(sale.debtAmount) > 0n && (
            <div className="pos-totals-row">
              <span>{t('receipt.debtAmount')}:</span>
              <span data-testid="receipt-debt-amount">
                {formatTiyinToSom(sale.debtAmount)} {t('common.currency')}
              </span>
            </div>
          )}
        </div>

        {printState.kind !== 'idle' && (
          <div className="pos-totals-row" data-testid="receipt-print-status">
            {printState.kind === 'printing' && t('receipt.printPrinting')}
            {printState.kind === 'printed' &&
              (printState.copyNumber > 1
                ? t('receipt.printCopyDone', { copy: String(printState.copyNumber) })
                : t('receipt.printDone'))}
            {printState.kind === 'disabled' && t('receipt.printDisabled')}
            {printState.kind === 'failed' &&
              t('receipt.printFailed', { message: printState.message })}
          </div>
        )}

        {api && (
          <button
            type="button"
            className="pos-btn"
            data-testid="receipt-reprint-btn"
            disabled={printState.kind === 'printing'}
            onClick={() => {
              void onReprint();
            }}
          >
            <Icon name="printer" />
            {t('receipt.reprintBtn')}
          </button>
        )}

        <button
          type="button"
          className="pos-btn pos-btn-primary pos-btn-xl"
          data-testid="receipt-new-sale-btn"
          autoFocus
          onClick={() => setActiveModal('none')}
        >
          <Icon name="plus" />
          {t('receipt.newSaleBtn')}
        </button>
      </div>
    </div>
  );
}

export function ShiftManagementModal({
  api,
  onShiftClosed,
  onError,
}: {
  readonly api: HubApiClient;
  readonly onShiftClosed: () => Promise<void>;
  readonly onError: (err: unknown) => void;
}) {
  const currentShift = usePosStore((s) => s.currentShift);
  const drawerCashBalance = usePosStore((s) => s.drawerCashBalance);
  const setShiftState = usePosStore((s) => s.setShiftState);
  const setLastShiftClosure = usePosStore((s) => s.setLastShiftClosure);
  const setActiveModal = usePosStore((s) => s.setActiveModal);

  const [tab, setTab] = useState<'cash_move' | 'close_shift'>('cash_move');
  const [moveType, setMoveType] = useState<'cash_in' | 'cash_out'>('cash_in');
  const [expenseCategory, setExpenseCategory] = useState<ShiftExpenseCategory | ''>('');
  const [moveAmountSom, setMoveAmountSom] = useState('');
  const [moveReason, setMoveReason] = useState('');
  const [moveRequestId, setMoveRequestId] = useState(() => generateBrowserUuidV7());

  // Close Shift state — STRICTLY cash recount only (no non-cash inputs!)
  const [countedCashSom, setCountedCashSom] = useState(tiyinToSomInputString(drawerCashBalance));
  const [discrepancyReason, setDiscrepancyReason] = useState('');
  const [closeNote, setCloseNote] = useState('');
  const [closeRequestId] = useState(() => generateBrowserUuidV7());
  const [needsSupervisor, setNeedsSupervisor] = useState(false);
  const [supervisorUsername, setSupervisorUsername] = useState('');
  const [supervisorPin, setSupervisorPin] = useState('');

  if (!currentShift) {
    return null;
  }

  const handleCashMoveSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const amountTiyin = parseSomInputToTiyinString(moveAmountSom);
      const res = await api.recordShiftCashMove(currentShift.id, {
        clientRequestId: moveRequestId,
        type: moveType,
        amount: amountTiyin,
        reason: moveReason,
        expenseCategory:
          moveType === 'cash_out' && expenseCategory !== '' ? expenseCategory : undefined,
      });
      setShiftState({
        shift: currentShift,
        drawerCashBalance: res.drawerCashBalance,
      });
      setCountedCashSom(tiyinToSomInputString(res.drawerCashBalance));
      setMoveAmountSom('');
      setMoveReason('');
      setMoveRequestId(generateBrowserUuidV7());
    } catch (err) {
      onError(err);
    }
  };

  const handleCloseShiftSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const countedCashTiyin = parseSomInputToTiyinString(countedCashSom);
      const override =
        needsSupervisor && supervisorUsername.trim().length > 0
          ? { username: supervisorUsername.trim(), pin: supervisorPin }
          : undefined;

      const res = await api.closeShift(currentShift.id, {
        clientRequestId: closeRequestId,
        countedCash: countedCashTiyin,
        discrepancyReason:
          discrepancyReason.trim().length > 0 ? discrepancyReason.trim() : undefined,
        override,
        note: closeNote.trim().length > 0 ? closeNote.trim() : null,
      });
      setLastShiftClosure(res.closure);
      setShiftState({
        shift: null,
        drawerCashBalance: res.drawerCashBalance,
      });
      setActiveModal('none');
      await onShiftClosed();
    } catch (err) {
      if (err instanceof HubApiError && err.code === 'SUPERVISOR_OVERRIDE_REQUIRED') {
        setNeedsSupervisor(true);
      }
      onError(err);
    }
  };

  return (
    <div className="pos-modal-backdrop" data-testid="shift-manage-modal">
      <div className="pos-modal-card">
        <div className="pos-modal-header">
          <h3 className="pos-modal-title pos-title-icon">
            <Icon name="shift" />
            {t('shift.manageTitle')}
          </h3>
          <button type="button" className="pos-btn" onClick={() => setActiveModal('none')}>
            <Icon name="close" />
            {t('common.close')}
          </button>
        </div>

        <div className="pos-totals-row">
          <span>{t('shift.expectedCash')}:</span>
          <strong data-testid="shift-drawer-balance">
            {formatTiyinToSom(drawerCashBalance)} {t('common.currency')}
          </strong>
        </div>

        <div className="pos-tabs">
          <button
            type="button"
            className={`pos-btn ${tab === 'cash_move' ? 'pos-btn-primary' : ''}`}
            data-testid="shift-tab-cash-move"
            onClick={() => setTab('cash_move')}
          >
            <Icon name="cash" />
            {t('shift.tabCashMove')}
          </button>
          <button
            type="button"
            className={`pos-btn ${tab === 'close_shift' ? 'pos-btn-primary' : ''}`}
            data-testid="shift-tab-close-shift"
            onClick={() => setTab('close_shift')}
          >
            <Icon name="lock" />
            {t('shift.tabCloseShift')}
          </button>
        </div>

        {tab === 'cash_move' ? (
          <form onSubmit={(e) => void handleCashMoveSubmit(e)}>
            <div className="pos-form-group">
              <label className="pos-form-label" htmlFor="cm-type">
                {t('shift.cashMoveType')}
              </label>
              <select
                id="cm-type"
                className="pos-select"
                data-testid="cash-move-type-select"
                value={moveType}
                onChange={(e) => setMoveType(e.target.value as 'cash_in' | 'cash_out')}
              >
                <option value="cash_in">{t('shift.cashIn')}</option>
                <option value="cash_out">{t('shift.cashOut')}</option>
              </select>
            </div>

            {moveType === 'cash_out' && (
              <div className="pos-form-group">
                <label className="pos-form-label" htmlFor="cm-exp-cat">
                  {t('shift.expenseCategory')}
                </label>
                <select
                  id="cm-exp-cat"
                  className="pos-select"
                  data-testid="cash-move-expense-category"
                  value={expenseCategory}
                  onChange={(e) => setExpenseCategory(e.target.value as ShiftExpenseCategory | '')}
                >
                  <option value="">—</option>
                  {EXPENSE_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="pos-form-group">
              <label className="pos-form-label" htmlFor="cm-amount">
                {t('shift.cashMoveAmount')}
              </label>
              <input
                id="cm-amount"
                className="pos-input"
                data-testid="cash-move-amount-input"
                value={moveAmountSom}
                onChange={(e) => setMoveAmountSom(e.target.value)}
                required
              />
            </div>

            <div className="pos-form-group">
              <label className="pos-form-label" htmlFor="cm-reason">
                {t('shift.cashMoveReason')}
              </label>
              <input
                id="cm-reason"
                className="pos-input"
                data-testid="cash-move-reason-input"
                value={moveReason}
                onChange={(e) => setMoveReason(e.target.value)}
                required
              />
            </div>

            <button
              type="submit"
              className="pos-btn pos-btn-primary pos-btn-xl"
              data-testid="cash-move-submit-btn"
            >
              <Icon name="check" />
              {t('shift.recordCashMove')}
            </button>
          </form>
        ) : (
          <form onSubmit={(e) => void handleCloseShiftSubmit(e)} data-testid="close-shift-form">
            <p>{t('shift.closeNotice')}</p>
            <div className="pos-form-group">
              <label className="pos-form-label" htmlFor="cs-counted">
                {t('shift.countedCash')}
              </label>
              <input
                id="cs-counted"
                className="pos-input"
                data-testid="close-shift-counted-cash-input"
                value={countedCashSom}
                onChange={(e) => setCountedCashSom(e.target.value)}
                required
              />
            </div>

            <div className="pos-form-group">
              <label className="pos-form-label" htmlFor="cs-reason">
                {t('shift.closeDiscrepancyReason')}
              </label>
              <input
                id="cs-reason"
                className="pos-input"
                data-testid="close-shift-discrepancy-reason-input"
                value={discrepancyReason}
                onChange={(e) => setDiscrepancyReason(e.target.value)}
              />
            </div>

            <div className="pos-form-group">
              <label className="pos-form-label" htmlFor="cs-note">
                {t('shift.closeNote')}
              </label>
              <input
                id="cs-note"
                className="pos-input"
                data-testid="close-shift-note-input"
                value={closeNote}
                onChange={(e) => setCloseNote(e.target.value)}
              />
            </div>

            {needsSupervisor && (
              <div className="pos-pane" data-testid="close-shift-supervisor-box">
                <strong>{t('supervisor.title')}</strong>
                <input
                  className="pos-input"
                  data-testid="close-shift-supervisor-username"
                  placeholder={t('supervisor.username')}
                  value={supervisorUsername}
                  onChange={(e) => setSupervisorUsername(e.target.value)}
                />
                <input
                  type="password"
                  className="pos-input"
                  data-testid="close-shift-supervisor-pin"
                  placeholder={t('supervisor.pin')}
                  value={supervisorPin}
                  onChange={(e) => setSupervisorPin(e.target.value)}
                />
              </div>
            )}

            <button
              type="submit"
              className="pos-btn pos-btn-danger pos-btn-xl"
              data-testid="close-shift-submit-btn"
            >
              <Icon name="lock" />
              {t('shift.closeButton')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
