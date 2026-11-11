import type { SalePaymentInputDto } from '@mezon/contracts';
import type { ShiftExpenseCategory } from '@mezon/domain';
import { t } from '@mezon/i18n';
import {
  formatMilliToQtyString,
  formatTiyinToSom,
  parseSomInputToTiyinString,
  tiyinToSomInputString,
} from '@mezon/ui';
import { type FormEvent, useState } from 'react';
import { type HubApiClient, HubApiError } from '../api/hub-client.js';
import { type InsufficientStockLineDetail, usePosStore } from '../store/pos-store.js';
import { generateBrowserUuidV7 } from '../utils/browser-uuid.js';

type NonCashMethod = 'card' | 'uzqr' | 'payme' | 'click' | 'uzum' | 'social_card' | 'other';

const NON_CASH_METHODS: readonly NonCashMethod[] = [
  'card',
  'uzqr',
  'payme',
  'click',
  'uzum',
  'social_card',
  'other',
];

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

  const onInputsChanged = () => {
    if (networkRetryPending) {
      setNetworkRetryPending(false);
      rotatePaymentClientRequestId();
    }
  };

  const submitSale = async (overrideTotalTiyin?: string) => {
    if (isSubmittingPayment) {
      return;
    }
    const targetExpectedTotal = overrideTotalTiyin ?? expectedTotalTiyin;
    setIsSubmittingPayment(true);
    setErrorBanner(null);

    try {
      const payments: SalePaymentInputDto[] = [];
      if (cashAppliedTiyin > 0n && tenderedCashTiyin > 0n) {
        payments.push({
          method: 'cash',
          tenderedAmount: tenderedCashTiyin.toString(),
          amount: cashAppliedTiyin.toString(),
        });
      }
      for (const row of nonCashRows) {
        if (row.amountSom.trim().length > 0) {
          const amt = parseSomInputToTiyinString(row.amountSom);
          if (BigInt(amt) > 0n) {
            payments.push({
              method: row.method,
              amount: amt,
              providerRef: row.providerRef.trim() || null,
            });
          }
        }
      }

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
      <form className="pos-modal-card" onSubmit={handleFormSubmit}>
        <div className="pos-modal-header">
          <h3 className="pos-modal-title">{t('payment.title')}</h3>
          <button type="button" className="pos-btn" onClick={() => setActiveModal('none')}>
            {t('common.close')}
          </button>
        </div>

        <div className="pos-totals-grand" data-testid="payment-total-display">
          <span>{t('payment.totalToPay')}:</span>
          <span>
            {formatTiyinToSom(expectedTotalTiyin)} {t('common.currency')}
          </span>
        </div>

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
          <label className="pos-form-label" htmlFor="pay-tendered-cash">
            {t('payment.tenderedCash')}
          </label>
          <input
            id="pay-tendered-cash"
            className="pos-input"
            data-testid="payment-tendered-cash-input"
            value={tenderedCashSom}
            onChange={(e) => {
              onInputsChanged();
              setTenderedCashSom(e.target.value);
            }}
            autoFocus
          />
          <div className="pos-quick-tenders">
            <button
              type="button"
              className="pos-btn"
              data-testid="payment-exact-cash-btn"
              onClick={() => {
                onInputsChanged();
                setTenderedCashSom(tiyinToSomInputString(remainingForCashTiyin.toString()));
              }}
            >
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

        <div className="pos-totals-box">
          <div className="pos-totals-row">
            <span>{t('payment.cashApplied')}:</span>
            <strong data-testid="payment-cash-applied">
              {formatTiyinToSom(cashAppliedTiyin)} {t('common.currency')}
            </strong>
          </div>
          <div className="pos-totals-row">
            <span>{t('payment.changeDue')}:</span>
            <strong data-testid="payment-change-due">
              {formatTiyinToSom(changeDueTiyin)} {t('common.currency')}
            </strong>
          </div>
        </div>

        <div>
          <button
            type="button"
            className="pos-btn"
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
            {t('payment.addNonCashBtn')}
          </button>

          {nonCashRows.map((row, index) => (
            <div
              key={row.key}
              className="pos-search-bar"
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
                className="pos-btn pos-btn-danger"
                onClick={() => {
                  onInputsChanged();
                  setNonCashRows((prev) => prev.filter((r) => r.key !== row.key));
                }}
              >
                {t('common.delete')}
              </button>
            </div>
          ))}
        </div>

        <div className="pos-form-group">
          <label className="pos-form-label" htmlFor="pay-debt-som">
            {t('payment.debtAmount')} {selectedCustomer ? `(${selectedCustomer.fullName})` : ''}
          </label>
          <div className="pos-search-bar">
            <input
              id="pay-debt-som"
              className="pos-input"
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

        <div className="pos-totals-row">
          <span>{t('payment.remainingUnallocated')}:</span>
          <strong data-testid="payment-unallocated">
            {formatTiyinToSom(unallocatedTiyin)} {t('common.currency')}
          </strong>
        </div>

        <div className="pos-top-actions">
          <button
            type="submit"
            className="pos-btn pos-btn-success"
            data-testid="payment-complete-btn"
            disabled={isSubmittingPayment || unallocatedTiyin !== 0n}
          >
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
              {t('common.retry')}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

export function ReceiptModal() {
  const lastCompletedSale = usePosStore((s) => s.lastCompletedSale);
  const setActiveModal = usePosStore((s) => s.setActiveModal);

  if (!lastCompletedSale) {
    return null;
  }

  const { sale } = lastCompletedSale;

  return (
    <div className="pos-modal-backdrop" data-testid="receipt-modal">
      <div className="pos-modal-card">
        <div className="pos-non-fiscal-banner" data-testid="receipt-non-fiscal-banner">
          {t('receipt.nonFiscalBanner')}
        </div>

        <div className="pos-modal-header">
          <h3 className="pos-modal-title">{t('receipt.title')}</h3>
          <span data-testid="receipt-code">{sale.receiptCode}</span>
        </div>

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

        <button
          type="button"
          className="pos-btn pos-btn-primary"
          data-testid="receipt-new-sale-btn"
          autoFocus
          onClick={() => setActiveModal('none')}
        >
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
          <h3 className="pos-modal-title">{t('shift.manageTitle')}</h3>
          <button type="button" className="pos-btn" onClick={() => setActiveModal('none')}>
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
            {t('shift.tabCashMove')}
          </button>
          <button
            type="button"
            className={`pos-btn ${tab === 'close_shift' ? 'pos-btn-primary' : ''}`}
            data-testid="shift-tab-close-shift"
            onClick={() => setTab('close_shift')}
          >
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
              className="pos-btn pos-btn-primary"
              data-testid="cash-move-submit-btn"
            >
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
              className="pos-btn pos-btn-danger"
              data-testid="close-shift-submit-btn"
            >
              {t('shift.closeButton')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
