import type { ProductUnit } from '@mezon/domain';
import { t } from '@mezon/i18n';
import {
  formatMilliToQtyString,
  formatTiyinToSom,
  parseQtyInputToMilliString,
  parseSomInputToTiyinString,
} from '@mezon/ui';
import { type FormEvent, useState } from 'react';
import type { HubApiClient } from '../api/hub-client.js';
import { usePosStore } from '../store/pos-store.js';

const UNITS: readonly ProductUnit[] = ['dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq'];

export function ShortcutsModal() {
  const setActiveModal = usePosStore((s) => s.setActiveModal);

  return (
    <div className="pos-modal-backdrop" data-testid="shortcuts-modal">
      <div className="pos-modal-card">
        <div className="pos-modal-header">
          <h3 className="pos-modal-title">{t('shortcuts.title')}</h3>
          <button
            type="button"
            className="pos-btn"
            data-testid="shortcuts-close-btn"
            onClick={() => setActiveModal('none')}
          >
            {t('common.close')}
          </button>
        </div>
        <ul>
          <li>{t('shortcuts.f1')}</li>
          <li>{t('shortcuts.f2')}</li>
          <li>{t('shortcuts.f3')}</li>
          <li>{t('shortcuts.f4')}</li>
          <li>{t('shortcuts.f5')}</li>
          <li>{t('shortcuts.f6')}</li>
          <li>{t('shortcuts.f7')}</li>
          <li>{t('shortcuts.f8')}</li>
          <li>{t('shortcuts.f9')}</li>
          <li>{t('shortcuts.arrows')}</li>
          <li>{t('shortcuts.plusMinus')}</li>
          <li>{t('shortcuts.delete')}</li>
          <li>{t('shortcuts.escape')}</li>
        </ul>
      </div>
    </div>
  );
}

export function QuickSaleModal({
  api,
  onError,
}: {
  readonly api: HubApiClient;
  readonly onError: (err: unknown) => void;
}) {
  const activeCart = usePosStore((s) => s.activeCart);
  const setActiveCart = usePosStore((s) => s.setActiveCart);
  const setActiveModal = usePosStore((s) => s.setActiveModal);

  const [name, setName] = useState('');
  const [unit, setUnit] = useState<ProductUnit>('dona');
  const [qtyStr, setQtyStr] = useState('1');
  const [priceSomStr, setPriceSomStr] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeCart) {
      return;
    }
    try {
      const qtyMilli = parseQtyInputToMilliString(qtyStr, unit);
      const unitPriceTiyin = parseSomInputToTiyinString(priceSomStr);
      const res = await api.addCartLine(activeCart.id, {
        kind: 'quick_sale',
        name,
        unit,
        qty: qtyMilli,
        unitPrice: unitPriceTiyin,
      });
      setActiveCart(res.cart);
      setActiveModal('none');
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="pos-modal-backdrop" data-testid="quick-sale-modal">
      <form className="pos-modal-card" onSubmit={(e) => void handleSubmit(e)}>
        <div className="pos-modal-header">
          <h3 className="pos-modal-title">{t('quickSale.title')}</h3>
          <button type="button" className="pos-btn" onClick={() => setActiveModal('none')}>
            {t('common.close')}
          </button>
        </div>

        <div className="pos-form-group">
          <label className="pos-form-label" htmlFor="qs-name">
            {t('quickSale.name')}
          </label>
          <input
            id="qs-name"
            className="pos-input"
            data-testid="quick-sale-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
        </div>

        <div className="pos-form-group">
          <label className="pos-form-label" htmlFor="qs-unit">
            {t('quickSale.unit')}
          </label>
          <select
            id="qs-unit"
            className="pos-select"
            data-testid="quick-sale-unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value as ProductUnit)}
          >
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {t(`unit.${u}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="pos-form-group">
          <label className="pos-form-label" htmlFor="qs-qty">
            {t('quickSale.qty')}
          </label>
          <input
            id="qs-qty"
            className="pos-input"
            data-testid="quick-sale-qty"
            value={qtyStr}
            onChange={(e) => setQtyStr(e.target.value)}
            required
          />
        </div>

        <div className="pos-form-group">
          <label className="pos-form-label" htmlFor="qs-price">
            {t('quickSale.unitPrice')}
          </label>
          <input
            id="qs-price"
            className="pos-input"
            data-testid="quick-sale-price"
            value={priceSomStr}
            onChange={(e) => setPriceSomStr(e.target.value)}
            required
          />
        </div>

        <div className="pos-top-actions">
          <button type="submit" className="pos-btn pos-btn-primary" data-testid="quick-sale-submit">
            {t('quickSale.addBtn')}
          </button>
          <button type="button" className="pos-btn" onClick={() => setActiveModal('none')}>
            {t('common.cancel')}
          </button>
        </div>
      </form>
    </div>
  );
}

export function EditQtyModal({
  api,
  onError,
}: {
  readonly api: HubApiClient;
  readonly onError: (err: unknown) => void;
}) {
  const activeCart = usePosStore((s) => s.activeCart);
  const selectedLineId = usePosStore((s) => s.selectedLineId);
  const setActiveCart = usePosStore((s) => s.setActiveCart);
  const setActiveModal = usePosStore((s) => s.setActiveModal);

  const line = activeCart?.lines.find((l) => l.id === selectedLineId) ?? null;
  const [qtyStr, setQtyStr] = useState(line ? formatMilliToQtyString(line.qty) : '1');

  if (!activeCart || !line) {
    return null;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const qtyMilli = parseQtyInputToMilliString(qtyStr, line.unit);
      const res = await api.updateCartLine(activeCart.id, line.id, {
        qty: qtyMilli,
      });
      setActiveCart(res.cart);
      setActiveModal('none');
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="pos-modal-backdrop" data-testid="edit-qty-modal">
      <form className="pos-modal-card" onSubmit={(e) => void handleSubmit(e)}>
        <div className="pos-modal-header">
          <h3 className="pos-modal-title">
            {t('pos.editQtyTitle')}: {line.name}
          </h3>
          <button type="button" className="pos-btn" onClick={() => setActiveModal('none')}>
            {t('common.close')}
          </button>
        </div>
        <div className="pos-form-group">
          <label className="pos-form-label" htmlFor="edit-qty-input">
            {t('pos.newQtyLabel')} ({t(`unit.${line.unit}`)})
          </label>
          <input
            id="edit-qty-input"
            className="pos-input"
            data-testid="edit-qty-input"
            value={qtyStr}
            onChange={(e) => setQtyStr(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="pos-top-actions">
          <button type="submit" className="pos-btn pos-btn-primary" data-testid="edit-qty-submit">
            {t('common.save')}
          </button>
        </div>
      </form>
    </div>
  );
}

export function DiscountModal({
  api,
  onError,
}: {
  readonly api: HubApiClient;
  readonly onError: (err: unknown) => void;
}) {
  const activeCart = usePosStore((s) => s.activeCart);
  const setActiveCart = usePosStore((s) => s.setActiveCart);
  const setActiveModal = usePosStore((s) => s.setActiveModal);

  const [mode, setMode] = useState<'none' | 'percent' | 'amount'>('percent');
  const [valueStr, setValueStr] = useState('5');
  const [reason, setReason] = useState('');
  const [needsSupervisor, setNeedsSupervisor] = useState(false);
  const [supervisorUsername, setSupervisorUsername] = useState('');
  const [supervisorPin, setSupervisorPin] = useState('');

  if (!activeCart) {
    return null;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const override =
        needsSupervisor && supervisorUsername.trim().length > 0
          ? { username: supervisorUsername.trim(), pin: supervisorPin }
          : undefined;

      if (mode === 'none') {
        const res = await api.setCartDiscount(activeCart.id, { mode: 'none' });
        setActiveCart(res.cart);
        setActiveModal('none');
        return;
      }

      if (mode === 'percent') {
        const pctNum = Number(valueStr.replace(',', '.'));
        const percentBp = Math.round(pctNum * 100);
        const res = await api.setCartDiscount(activeCart.id, {
          mode: 'percent',
          percentBp,
          reason: reason.trim() || null,
          override,
        });
        setActiveCart(res.cart);
        setActiveModal('none');
        return;
      }

      const amountTiyin = parseSomInputToTiyinString(valueStr);
      const res = await api.setCartDiscount(activeCart.id, {
        mode: 'amount',
        amount: amountTiyin,
        reason: reason.trim() || null,
        override,
      });
      setActiveCart(res.cart);
      setActiveModal('none');
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { readonly code?: string }).code === 'DISCOUNT_OVERRIDE_REQUIRED'
      ) {
        setNeedsSupervisor(true);
      }
      onError(err);
    }
  };

  return (
    <div className="pos-modal-backdrop" data-testid="discount-modal">
      <form className="pos-modal-card" onSubmit={(e) => void handleSubmit(e)}>
        <div className="pos-modal-header">
          <h3 className="pos-modal-title">{t('discount.title')}</h3>
          <button type="button" className="pos-btn" onClick={() => setActiveModal('none')}>
            {t('common.close')}
          </button>
        </div>

        <div className="pos-tabs">
          <button
            type="button"
            className={`pos-btn ${mode === 'percent' ? 'pos-btn-primary' : ''}`}
            data-testid="discount-mode-percent"
            onClick={() => setMode('percent')}
          >
            {t('discount.modePercent')}
          </button>
          <button
            type="button"
            className={`pos-btn ${mode === 'amount' ? 'pos-btn-primary' : ''}`}
            data-testid="discount-mode-amount"
            onClick={() => setMode('amount')}
          >
            {t('discount.modeAmount')}
          </button>
          <button
            type="button"
            className={`pos-btn ${mode === 'none' ? 'pos-btn-primary' : ''}`}
            data-testid="discount-mode-none"
            onClick={() => setMode('none')}
          >
            {t('discount.modeNone')}
          </button>
        </div>

        {mode !== 'none' && (
          <>
            <div className="pos-form-group">
              <label className="pos-form-label" htmlFor="disc-val">
                {t('discount.valueLabel')}
              </label>
              <input
                id="disc-val"
                className="pos-input"
                data-testid="discount-value-input"
                value={valueStr}
                onChange={(e) => setValueStr(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div className="pos-form-group">
              <label className="pos-form-label" htmlFor="disc-reason">
                {t('discount.reasonLabel')}
              </label>
              <input
                id="disc-reason"
                className="pos-input"
                data-testid="discount-reason-input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </>
        )}

        {needsSupervisor && (
          <div className="pos-pane" data-testid="discount-supervisor-box">
            <strong>{t('supervisor.title')}</strong>
            <div className="pos-form-group">
              <label className="pos-form-label" htmlFor="disc-sup-user">
                {t('supervisor.username')}
              </label>
              <input
                id="disc-sup-user"
                className="pos-input"
                data-testid="discount-supervisor-username"
                value={supervisorUsername}
                onChange={(e) => setSupervisorUsername(e.target.value)}
                required
              />
            </div>
            <div className="pos-form-group">
              <label className="pos-form-label" htmlFor="disc-sup-pin">
                {t('supervisor.pin')}
              </label>
              <input
                id="disc-sup-pin"
                type="password"
                className="pos-input"
                data-testid="discount-supervisor-pin"
                value={supervisorPin}
                onChange={(e) => setSupervisorPin(e.target.value)}
                required
              />
            </div>
          </div>
        )}

        <div className="pos-top-actions">
          <button
            type="submit"
            className="pos-btn pos-btn-primary"
            data-testid="discount-submit-btn"
          >
            {needsSupervisor ? t('supervisor.approveBtn') : t('discount.applyBtn')}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ParkCartModal({
  api,
  onParked,
  onError,
}: {
  readonly api: HubApiClient;
  readonly onParked: () => Promise<void>;
  readonly onError: (err: unknown) => void;
}) {
  const activeCart = usePosStore((s) => s.activeCart);
  const setActiveModal = usePosStore((s) => s.setActiveModal);
  const [label, setLabel] = useState('');

  if (!activeCart) {
    return null;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.parkCart(activeCart.id, {
        label: label.trim().length > 0 ? label.trim() : null,
      });
      await onParked();
      setActiveModal('none');
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="pos-modal-backdrop" data-testid="park-cart-modal">
      <form className="pos-modal-card" onSubmit={(e) => void handleSubmit(e)}>
        <div className="pos-modal-header">
          <h3 className="pos-modal-title">{t('park.modalTitle')}</h3>
          <button type="button" className="pos-btn" onClick={() => setActiveModal('none')}>
            {t('common.close')}
          </button>
        </div>
        <div className="pos-form-group">
          <input
            className="pos-input"
            data-testid="park-label-input"
            placeholder={t('park.labelPlaceholder')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            autoFocus
          />
        </div>
        <div className="pos-top-actions">
          <button type="submit" className="pos-btn pos-btn-primary" data-testid="park-confirm-btn">
            {t('park.confirmBtn')}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ParkedCartsListModal({
  api,
  onResumed,
  onError,
}: {
  readonly api: HubApiClient;
  readonly onResumed: (cartId: string) => Promise<void>;
  readonly onError: (err: unknown) => void;
}) {
  const parkedCarts = usePosStore((s) => s.parkedCarts);
  const setParkedCarts = usePosStore((s) => s.setParkedCarts);
  const setActiveModal = usePosStore((s) => s.setActiveModal);

  const handleResume = async (cartId: string) => {
    try {
      await api.resumeCart(cartId);
      await onResumed(cartId);
      setActiveModal('none');
    } catch (err) {
      onError(err);
    }
  };

  const handleDelete = async (cartId: string) => {
    try {
      await api.deleteCart(cartId);
      const list = await api.listCarts();
      setParkedCarts(list.carts.filter((c) => c.status === 'parked'));
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="pos-modal-backdrop" data-testid="parked-carts-modal">
      <div className="pos-modal-card">
        <div className="pos-modal-header">
          <h3 className="pos-modal-title">{t('parked.listTitle')}</h3>
          <button type="button" className="pos-btn" onClick={() => setActiveModal('none')}>
            {t('common.close')}
          </button>
        </div>
        {parkedCarts.length === 0 ? (
          <p data-testid="parked-empty">{t('parked.empty')}</p>
        ) : (
          <div className="pos-product-list">
            {parkedCarts.map((c) => (
              <div key={c.id} className="pos-product-item" data-testid={`parked-cart-item-${c.id}`}>
                <div>
                  <strong>{c.parkLabel ?? c.id.slice(0, 8)}</strong>
                  <div>
                    {t('parked.linesCount', { count: c.lineCount })} —{' '}
                    {formatTiyinToSom(c.totalFinal)} {t('common.currency')}
                  </div>
                </div>
                <div className="pos-top-actions">
                  <button
                    type="button"
                    className="pos-btn pos-btn-primary"
                    data-testid={`parked-resume-btn-${c.id}`}
                    onClick={() => void handleResume(c.id)}
                  >
                    {t('parked.resumeBtn')}
                  </button>
                  <button
                    type="button"
                    className="pos-btn pos-btn-danger"
                    data-testid={`parked-delete-btn-${c.id}`}
                    onClick={() => void handleDelete(c.id)}
                  >
                    {t('parked.deleteBtn')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function CustomerModal({
  api,
  onError,
}: {
  readonly api: HubApiClient;
  readonly onError: (err: unknown) => void;
}) {
  const customerList = usePosStore((s) => s.customerList);
  const setCustomerList = usePosStore((s) => s.setCustomerList);
  const selectedCustomer = usePosStore((s) => s.selectedCustomer);
  const setSelectedCustomer = usePosStore((s) => s.setSelectedCustomer);
  const setActiveModal = usePosStore((s) => s.setActiveModal);

  const [query, setQuery] = useState('');
  const [newFullName, setNewFullName] = useState('');
  const [newPhone, setNewPhone] = useState('');

  const handleSearch = async (q: string) => {
    setQuery(q);
    try {
      const res = await api.listCustomers({ q: q.trim() || undefined, limit: 30 });
      setCustomerList(res.items);
    } catch (err) {
      onError(err);
    }
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.createCustomer({
        fullName: newFullName,
        phone: newPhone.trim().length > 0 ? newPhone.trim() : null,
      });
      setSelectedCustomer(res.customer);
      setActiveModal('none');
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="pos-modal-backdrop" data-testid="customer-modal">
      <div className="pos-modal-card">
        <div className="pos-modal-header">
          <h3 className="pos-modal-title">{t('customer.modalTitle')}</h3>
          <button type="button" className="pos-btn" onClick={() => setActiveModal('none')}>
            {t('common.close')}
          </button>
        </div>

        <div className="pos-form-group">
          <input
            className="pos-input"
            data-testid="customer-search-input"
            placeholder={t('customer.searchPlaceholder')}
            value={query}
            onChange={(e) => void handleSearch(e.target.value)}
            autoFocus
          />
        </div>

        {selectedCustomer && (
          <div className="pos-top-actions">
            <span>{selectedCustomer.fullName}</span>
            <button
              type="button"
              className="pos-btn"
              onClick={() => {
                setSelectedCustomer(null);
                setActiveModal('none');
              }}
            >
              {t('customer.clearBtn')}
            </button>
          </div>
        )}

        <div className="pos-product-list">
          {customerList.map((cust) => (
            <button
              key={cust.id}
              type="button"
              className="pos-product-item"
              data-testid={`customer-select-${cust.id}`}
              onClick={() => {
                setSelectedCustomer(cust);
                setActiveModal('none');
              }}
            >
              <span>
                <strong>{cust.fullName}</strong>{' '}
                {cust.phoneNormalized ? `(${cust.phoneNormalized})` : ''}
              </span>
              <span>
                {t('customer.balance', {
                  amount: `${formatTiyinToSom(cust.balance)} ${t('common.currency')}`,
                })}
              </span>
            </button>
          ))}
        </div>

        <form onSubmit={(e) => void handleCreate(e)} className="pos-totals-box">
          <div className="pos-form-group">
            <input
              className="pos-input"
              data-testid="customer-new-name"
              placeholder={t('customer.newFullName')}
              value={newFullName}
              onChange={(e) => setNewFullName(e.target.value)}
              required
            />
          </div>
          <div className="pos-form-group">
            <input
              className="pos-input"
              data-testid="customer-new-phone"
              placeholder={t('customer.newPhone')}
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
            />
          </div>
          <button
            type="submit"
            className="pos-btn pos-btn-primary"
            data-testid="customer-create-btn"
          >
            {t('customer.createBtn')}
          </button>
        </form>
      </div>
    </div>
  );
}
