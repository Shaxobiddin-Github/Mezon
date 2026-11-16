import {
  LegalAddressSchema,
  LegalNameSchema,
  MxikSchema,
  PackageCodeSchema,
  type ProductSummaryDto,
  TinSchema,
  VatRateBpSchema,
} from '@mezon/contracts';
import type { ProductUnit } from '@mezon/domain';
import { t } from '@mezon/i18n';
import { formatTiyinToSom, parseSomInputToTiyinString } from '@mezon/ui';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { HubApiClient } from '../api/hub-client.js';

const UNITS: readonly ProductUnit[] = ['dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq'];
const PAGE_SIZE = 100;

/**
 * Percent text ("12", "12,5") → basis points without floats. A percent with ≤ 2 decimals has the
 * same scale as so'm→tiyin, so the shared UI money parser is reused. Returns null when invalid.
 */
export function parseVatPercentInputToBp(raw: string): number | null {
  try {
    const bp = Number(parseSomInputToTiyinString(raw.trim() === '' ? '0' : raw));
    const parsed = VatRateBpSchema.safeParse(bp);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function formatVatBpAsPercent(bp: number): string {
  return formatTiyinToSom(BigInt(bp)).replace(/\s/g, '');
}

interface ProductFormState {
  readonly name: string;
  readonly unit: ProductUnit;
  readonly salePriceSom: string;
  readonly mxik: string;
  readonly packageCode: string;
  readonly vatPercent: string;
}

export interface ProductFormResult {
  readonly name: string;
  readonly unit: ProductUnit;
  readonly salePrice: string;
  readonly mxik: string | null;
  readonly packageCode: string | null;
  readonly vatRateBp: number;
}

/**
 * Validates the product form with the SAME contracts schemas the hub uses (no duplicated rules).
 * Returns either the normalized payload or an i18n error message.
 */
export function validateProductForm(
  form: ProductFormState,
): { ok: true; value: ProductFormResult } | { ok: false; error: string } {
  const name = form.name.trim();
  if (name.length === 0) {
    return { ok: false, error: t('catalog.form.invalidName') };
  }
  let salePrice: string;
  try {
    salePrice = parseSomInputToTiyinString(form.salePriceSom);
    if (BigInt(salePrice) < 0n) {
      return { ok: false, error: t('catalog.form.invalidPrice') };
    }
  } catch {
    return { ok: false, error: t('catalog.form.invalidPrice') };
  }
  const mxik = MxikSchema.safeParse(form.mxik);
  if (!mxik.success) {
    return { ok: false, error: t('catalog.form.invalidMxik') };
  }
  const packageCode = PackageCodeSchema.safeParse(form.packageCode);
  if (!packageCode.success) {
    return { ok: false, error: t('catalog.form.invalidPackageCode') };
  }
  const vatRateBp = parseVatPercentInputToBp(form.vatPercent);
  if (vatRateBp === null) {
    return { ok: false, error: t('catalog.form.invalidVat') };
  }
  return {
    ok: true,
    value: {
      name,
      unit: form.unit,
      salePrice,
      mxik: mxik.data,
      packageCode: packageCode.data,
      vatRateBp,
    },
  };
}

function ProductFormModal(props: {
  readonly api: HubApiClient;
  readonly product: ProductSummaryDto | null;
  readonly defaultVatRateBp: number;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly onError: (err: unknown) => void;
}) {
  const { api, product, defaultVatRateBp, onClose, onSaved, onError } = props;
  const [form, setForm] = useState<ProductFormState>(() => ({
    name: product?.name ?? '',
    unit: product?.unit ?? 'dona',
    salePriceSom: product ? formatTiyinToSom(product.salePrice).replace(/\s/g, '') : '',
    mxik: product?.mxik ?? '',
    packageCode: product?.packageCode ?? '',
    vatPercent: formatVatBpAsPercent(product?.vatRateBp ?? defaultVatRateBp),
  }));
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const res = validateProductForm(form);
    if (!res.ok) {
      setFormError(res.error);
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      if (product) {
        await api.updateProduct(product.id, {
          name: res.value.name,
          unit: res.value.unit,
          salePrice: res.value.salePrice,
          mxik: res.value.mxik,
          packageCode: res.value.packageCode,
          vatRateBp: res.value.vatRateBp,
        });
      } else {
        await api.createProduct({
          name: res.value.name,
          unit: res.value.unit,
          salePrice: res.value.salePrice,
          mxik: res.value.mxik,
          packageCode: res.value.packageCode,
          vatRateBp: res.value.vatRateBp,
        });
      }
      onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof ProductFormState, label: string, testId: string) => (
    <label className="pos-form-field">
      <span>{label}</span>
      <input
        className="pos-input"
        data-testid={testId}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </label>
  );

  return (
    <div className="pos-modal-backdrop" data-testid="product-form-modal">
      <form className="pos-modal-card" onSubmit={(e) => void handleSubmit(e)}>
        <div className="pos-modal-header">
          <h3 className="pos-modal-title">
            {product ? t('catalog.form.editTitle') : t('catalog.form.createTitle')}
          </h3>
          <button type="button" className="pos-btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
        <div className="pos-modal-body" style={{ display: 'grid', gap: '8px' }}>
          {field('name', t('catalog.form.name'), 'product-form-name')}
          <label className="pos-form-field">
            <span>{t('catalog.form.unit')}</span>
            <select
              className="pos-input"
              data-testid="product-form-unit"
              value={form.unit}
              onChange={(e) => setForm({ ...form, unit: e.target.value as ProductUnit })}
            >
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
          {field('salePriceSom', t('catalog.form.salePrice'), 'product-form-price')}
          {field('mxik', t('catalog.form.mxik'), 'product-form-mxik')}
          {field('packageCode', t('catalog.form.packageCode'), 'product-form-package-code')}
          {field('vatPercent', t('catalog.form.vatPercent'), 'product-form-vat')}
          {formError && (
            <div className="pos-error-banner" role="alert" data-testid="product-form-error">
              {formError}
            </div>
          )}
        </div>
        <div className="pos-modal-footer">
          <button
            type="submit"
            className="pos-btn pos-btn-primary"
            data-testid="product-form-save"
            disabled={saving}
          >
            {t('common.save')}
          </button>
        </div>
      </form>
    </div>
  );
}

function TaxSettingsPanel(props: {
  readonly api: HubApiClient;
  readonly onError: (err: unknown) => void;
  readonly onSaved: (defaultVatRateBp: number) => void;
}) {
  const { api, onError, onSaved } = props;
  const [loaded, setLoaded] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [tin, setTin] = useState('');
  const [legalName, setLegalName] = useState('');
  const [legalAddress, setLegalAddress] = useState('');
  const [isVatPayer, setIsVatPayer] = useState(true);
  const [vatPercent, setVatPercent] = useState('0');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getTaxProfile()
      .then((res) => {
        if (cancelled) return;
        if (res.profile) {
          setConfigured(true);
          setTin(res.profile.tin);
          setLegalName(res.profile.legalName);
          setLegalAddress(res.profile.legalAddress);
          setIsVatPayer(res.profile.isVatPayer);
          setVatPercent(formatVatBpAsPercent(res.profile.defaultVatRateBp));
        }
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) onError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [api, onError]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!TinSchema.safeParse(tin).success) {
      setMessage(t('taxSettings.invalidTin'));
      return;
    }
    if (
      !LegalNameSchema.safeParse(legalName).success ||
      !LegalAddressSchema.safeParse(legalAddress).success
    ) {
      setMessage(t('taxSettings.invalidText'));
      return;
    }
    const bp = parseVatPercentInputToBp(vatPercent);
    if (bp === null) {
      setMessage(t('catalog.form.invalidVat'));
      return;
    }
    try {
      const res = await api.updateTaxProfile({
        tin,
        legalName,
        legalAddress,
        isVatPayer,
        defaultVatRateBp: bp,
      });
      setConfigured(res.profile !== null);
      setMessage(t('taxSettings.saved'));
      onSaved(bp);
    } catch (err) {
      onError(err);
    }
  };

  if (!loaded) {
    return <div>{t('common.loading')}</div>;
  }

  return (
    <form
      data-testid="tax-settings-form"
      style={{ display: 'grid', gap: '8px' }}
      onSubmit={(e) => void handleSubmit(e)}
    >
      {!configured && <div data-testid="tax-not-configured">{t('taxSettings.notConfigured')}</div>}
      <label className="pos-form-field">
        <span>{t('taxSettings.tin')}</span>
        <input
          className="pos-input"
          data-testid="tax-tin"
          inputMode="numeric"
          maxLength={9}
          value={tin}
          onChange={(e) => setTin(e.target.value)}
        />
      </label>
      <label className="pos-form-field">
        <span>{t('taxSettings.legalName')}</span>
        <input
          className="pos-input"
          data-testid="tax-legal-name"
          value={legalName}
          onChange={(e) => setLegalName(e.target.value)}
        />
      </label>
      <label className="pos-form-field">
        <span>{t('taxSettings.legalAddress')}</span>
        <input
          className="pos-input"
          data-testid="tax-legal-address"
          value={legalAddress}
          onChange={(e) => setLegalAddress(e.target.value)}
        />
      </label>
      <label className="pos-form-field">
        <input
          type="checkbox"
          data-testid="tax-is-vat-payer"
          checked={isVatPayer}
          onChange={(e) => setIsVatPayer(e.target.checked)}
        />
        <span>{t('taxSettings.isVatPayer')}</span>
      </label>
      {!isVatPayer && <div data-testid="tax-non-payer-note">{t('taxSettings.nonPayerNote')}</div>}
      <label className="pos-form-field">
        <span>{t('taxSettings.defaultVatPercent')}</span>
        <input
          className="pos-input"
          data-testid="tax-default-vat"
          value={vatPercent}
          onChange={(e) => setVatPercent(e.target.value)}
        />
      </label>
      {message && <div data-testid="tax-settings-message">{message}</div>}
      <button type="submit" className="pos-btn pos-btn-primary" data-testid="tax-settings-save">
        {t('common.save')}
      </button>
    </form>
  );
}

/**
 * T3.1 catalog management for owner/manager: product list with "MXIK'siz" filter and warning,
 * product create/edit form (MXIK, qadoq kodi, QQS) and organization tax settings.
 * Missing MXIK only WARNS here; fiscal-mode blocking is T3.2.
 */
export function CatalogScreen(props: {
  readonly api: HubApiClient;
  readonly onClose: () => void;
  readonly onError: (err: unknown) => void;
}) {
  const { api, onClose, onError } = props;
  const [tab, setTab] = useState<'products' | 'tax'>('products');
  const [query, setQuery] = useState('');
  const [missingOnly, setMissingOnly] = useState(false);
  const [products, setProducts] = useState<readonly ProductSummaryDto[]>([]);
  const [missingCount, setMissingCount] = useState(0);
  const [editing, setEditing] = useState<ProductSummaryDto | 'new' | null>(null);
  const [defaultVatRateBp, setDefaultVatRateBp] = useState(0);

  const reload = useCallback(async () => {
    try {
      const [list, count] = await Promise.all([
        api.listProducts({
          q: query.trim() === '' ? undefined : query,
          limit: PAGE_SIZE,
          offset: 0,
          missingMxik: missingOnly ? true : undefined,
        }),
        api.countProductsMissingMxik(),
      ]);
      setProducts(list.products);
      setMissingCount(count.count);
    } catch (err) {
      onError(err);
    }
  }, [api, query, missingOnly, onError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    api
      .getTaxProfile()
      .then((res) => {
        if (res.profile) setDefaultVatRateBp(res.profile.defaultVatRateBp);
      })
      .catch(() => {
        // Default VAT prefill is a convenience; the form still validates explicitly.
      });
  }, [api]);

  return (
    <div className="pos-modal-backdrop" data-testid="catalog-screen">
      <div className="pos-modal-card" style={{ maxWidth: '960px', width: '100%' }}>
        <div className="pos-modal-header">
          <h3 className="pos-modal-title">{t('catalog.title')}</h3>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              className={`pos-btn ${tab === 'products' ? 'pos-btn-primary' : ''}`}
              data-testid="catalog-tab-products"
              onClick={() => setTab('products')}
            >
              {t('catalog.openButton')}
            </button>
            <button
              type="button"
              className={`pos-btn ${tab === 'tax' ? 'pos-btn-primary' : ''}`}
              data-testid="catalog-tab-tax"
              onClick={() => setTab('tax')}
            >
              {t('taxSettings.tabTitle')}
            </button>
            <button
              type="button"
              className="pos-btn"
              data-testid="catalog-close-btn"
              onClick={onClose}
            >
              {t('common.close')}
            </button>
          </div>
        </div>

        <div className="pos-modal-body" style={{ display: 'grid', gap: '8px' }}>
          {tab === 'tax' ? (
            <TaxSettingsPanel api={api} onError={onError} onSaved={setDefaultVatRateBp} />
          ) : (
            <>
              {missingCount > 0 && (
                <div
                  className="pos-warning-banner"
                  role="status"
                  data-testid="missing-mxik-warning"
                >
                  {t('catalog.missingMxikWarning', { count: missingCount })}
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  className="pos-input"
                  data-testid="catalog-search"
                  placeholder={t('catalog.searchPlaceholder')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button
                  type="button"
                  className={`pos-btn ${missingOnly ? '' : 'pos-btn-primary'}`}
                  data-testid="catalog-filter-all"
                  onClick={() => setMissingOnly(false)}
                >
                  {t('catalog.filterAll')}
                </button>
                <button
                  type="button"
                  className={`pos-btn ${missingOnly ? 'pos-btn-primary' : ''}`}
                  data-testid="catalog-filter-missing-mxik"
                  onClick={() => setMissingOnly(true)}
                >
                  {t('catalog.filterMissingMxik', { count: missingCount })}
                </button>
                <button
                  type="button"
                  className="pos-btn pos-btn-primary"
                  data-testid="catalog-create-btn"
                  onClick={() => setEditing('new')}
                >
                  {t('catalog.createButton')}
                </button>
              </div>
              {products.length === 0 ? (
                <div data-testid="catalog-empty">{t('catalog.empty')}</div>
              ) : (
                <table className="pos-table" data-testid="catalog-table">
                  <thead>
                    <tr>
                      <th>{t('catalog.col.name')}</th>
                      <th>{t('catalog.col.price')}</th>
                      <th>{t('catalog.col.mxik')}</th>
                      <th>{t('catalog.col.vat')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p) => (
                      <tr key={p.id} data-testid={`catalog-row-${p.id}`}>
                        <td>{p.name}</td>
                        <td>{formatTiyinToSom(p.salePrice)}</td>
                        <td>{p.mxik ?? t('catalog.noMxik')}</td>
                        <td>{formatVatBpAsPercent(p.vatRateBp)}%</td>
                        <td>
                          <button
                            type="button"
                            className="pos-btn"
                            data-testid={`catalog-edit-${p.id}`}
                            onClick={() => setEditing(p)}
                          >
                            {t('catalog.editButton')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>

      {editing !== null && (
        <ProductFormModal
          api={api}
          product={editing === 'new' ? null : editing}
          defaultVatRateBp={defaultVatRateBp}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
          onError={onError}
        />
      )}
    </div>
  );
}
