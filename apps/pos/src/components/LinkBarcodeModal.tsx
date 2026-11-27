import type { ProductSummaryDto } from '@mezon/contracts';
import type { ProductUnit } from '@mezon/domain';
import { t } from '@mezon/i18n';
import { formatTiyinToSom, parseSomInputToTiyinString } from '@mezon/ui';
import { type FormEvent, useEffect, useState } from 'react';
import type { HubApiClient } from '../api/hub-client.js';
import { Icon } from './Icon.js';

const UNITS: readonly ProductUnit[] = ['dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq'];

/**
 * C19: a scanned code the catalog does not know. The owner/manager links it to an existing
 * product, or creates the product with this code, right from the sale screen; the scan is then
 * repeated so the item lands in the cart.
 */
export function LinkBarcodeModal({
  api,
  barcode,
  onClose,
  onLinked,
  onError,
}: {
  readonly api: HubApiClient;
  readonly barcode: string;
  readonly onClose: () => void;
  readonly onLinked: () => void;
  readonly onError: (err: unknown) => void;
}) {
  const [tab, setTab] = useState<'existing' | 'new'>('existing');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly ProductSummaryDto[]>([]);
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<ProductUnit>('dona');
  const [priceSom, setPriceSom] = useState('');

  useEffect(() => {
    if (tab !== 'existing') return;
    let alive = true;
    const timer = setTimeout(() => {
      const q = query.trim();
      api.listProducts({ ...(q !== '' ? { q } : {}), limit: 20 }).then(
        (res) => {
          if (alive) setResults(res.products);
        },
        (err: unknown) => {
          if (alive) onError(err);
        },
      );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, query, tab, onError]);

  const linkTo = async (product: ProductSummaryDto) => {
    setBusy(true);
    try {
      await api.addProductBarcode(product.id, { barcode });
      onLinked();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const createProduct = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createProduct({
        name,
        unit,
        salePrice: parseSomInputToTiyinString(priceSom),
        barcodes: [{ barcode }],
      });
      onLinked();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pos-modal-backdrop" data-testid="link-barcode-modal">
      <div className="pos-modal-card pos-link-card">
        <div className="pos-modal-header">
          <h3 className="pos-modal-title pos-title-icon">
            <Icon name="link" />
            {t('pos.link.title')}
          </h3>
          <button type="button" className="pos-btn" onClick={onClose}>
            <Icon name="close" />
            {t('common.close')}
          </button>
        </div>

        <p className="pos-link-code" data-testid="link-barcode-code">
          <Icon name="scan" />
          {barcode}
        </p>

        <div className="pos-tabs">
          <button
            type="button"
            className={`pos-btn ${tab === 'existing' ? 'pos-btn-primary' : ''}`}
            data-testid="link-tab-existing"
            onClick={() => setTab('existing')}
          >
            <Icon name="search" />
            {t('pos.link.tabExisting')}
          </button>
          <button
            type="button"
            className={`pos-btn ${tab === 'new' ? 'pos-btn-primary' : ''}`}
            data-testid="link-tab-new"
            onClick={() => setTab('new')}
          >
            <Icon name="plus" />
            {t('pos.link.tabNew')}
          </button>
        </div>

        {tab === 'existing' ? (
          <div className="pos-link-existing">
            <input
              className="pos-input"
              data-testid="link-search"
              placeholder={t('pos.link.searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            <div className="pos-link-results">
              {results.length === 0 ? (
                <p className="pos-int-text">{t('pos.noSearchResults')}</p>
              ) : (
                results.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="pos-btn pos-link-result"
                    data-testid="link-result"
                    disabled={busy}
                    onClick={() => void linkTo(p)}
                  >
                    <span className="pos-link-result-name">{p.name}</span>
                    <span className="pos-link-result-price">
                      {formatTiyinToSom(p.salePrice)} {t('common.currency')} / {t(`unit.${p.unit}`)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <form className="pos-link-new" onSubmit={(e) => void createProduct(e)}>
            <div className="pos-form-group">
              <label className="pos-form-label" htmlFor="link-name">
                {t('pos.link.name')}
              </label>
              <input
                id="link-name"
                className="pos-input"
                data-testid="link-new-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="pos-form-group">
              <label className="pos-form-label" htmlFor="link-price">
                {t('pos.link.price')}
              </label>
              <input
                id="link-price"
                className="pos-input pos-input-money"
                data-testid="link-new-price"
                inputMode="numeric"
                value={priceSom}
                onChange={(e) => setPriceSom(e.target.value)}
                required
              />
            </div>
            <div className="pos-form-group">
              <label className="pos-form-label" htmlFor="link-unit">
                {t('pos.link.unit')}
              </label>
              <select
                id="link-unit"
                className="pos-select"
                data-testid="link-new-unit"
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
            <button
              type="submit"
              className="pos-btn pos-btn-success pos-btn-xl"
              data-testid="link-new-submit"
              disabled={busy}
            >
              <Icon name="check" />
              {t('pos.link.create')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
