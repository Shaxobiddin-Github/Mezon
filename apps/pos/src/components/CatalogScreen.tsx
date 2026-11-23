import {
  BarcodeInputSchema,
  CatalogSkuSchema,
  CategoryNameSchema,
  type CategorySummaryDto,
  LegalAddressSchema,
  LegalNameSchema,
  MxikSchema,
  PackageCodeSchema,
  type ProductBarcodeSummaryDto,
  type ProductSummaryDto,
  TinSchema,
  UuidV7Schema,
  VatRateBpSchema,
} from '@mezon/contracts';
import {
  DomainError,
  type ProductUnit,
  type UuidV7,
  parseQuantityDecimal,
  prepareBarcodeForStorage,
  quantityToMilli,
} from '@mezon/domain';
import { t } from '@mezon/i18n';
import { formatMilliToQtyString, formatTiyinToSom, parseSomInputToTiyinString } from '@mezon/ui';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { HubApiClient } from '../api/hub-client.js';
import { describeHubError } from '../utils/error-text.js';

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

export interface ProductFormState {
  readonly name: string;
  readonly unit: ProductUnit;
  readonly salePriceSom: string;
  readonly mxik: string;
  readonly packageCode: string;
  readonly vatPercent: string;
  /** C11: the new barcode typed or scanned (create: the first one; edit: one more). */
  readonly barcode: string;
  readonly sku: string;
  /** '' = no category, NEW_CATEGORY = create one from `newCategoryName`, else a category id. */
  readonly categoryId: string;
  readonly newCategoryName: string;
  readonly unlimited: boolean;
  readonly minStock: string;
}

export const NEW_CATEGORY = '__new__';

export interface ProductFormResult {
  readonly name: string;
  readonly unit: ProductUnit;
  readonly salePrice: string;
  readonly mxik: string | null;
  readonly packageCode: string | null;
  readonly vatRateBp: number;
  readonly barcode: string | null;
  readonly sku: string | null;
  readonly categoryId: UuidV7 | null;
  readonly newCategoryName: string | null;
  readonly unlimited: boolean;
  /** Milli-units (0.001), as the hub stores quantities; null = no low-stock warning. */
  readonly minStock: string | null;
}

/** "5", "2,5", "0.125" -> milli-units string; '' -> null; invalid -> undefined. */
export function parseMinStockInput(raw: string): string | null | undefined {
  const cleaned = raw.trim().replace(/\s+/g, '').replace(/,/g, '.');
  if (cleaned === '') return null;
  try {
    const qty = parseQuantityDecimal(cleaned);
    return quantityToMilli(qty) < 0n ? undefined : quantityToMilli(qty).toString();
  } catch {
    return undefined;
  }
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
  const barcodeRaw = form.barcode.trim();
  if (barcodeRaw !== '') {
    if (!BarcodeInputSchema.safeParse({ barcode: barcodeRaw }).success) {
      return { ok: false, error: t('catalog.form.invalidBarcode') };
    }
    try {
      prepareBarcodeForStorage(barcodeRaw);
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof DomainError && err.code === 'INVALID_BARCODE_CHECK_DIGIT'
            ? t('error.INVALID_BARCODE_CHECK_DIGIT')
            : t('catalog.form.invalidBarcode'),
      };
    }
  }
  const sku = CatalogSkuSchema.safeParse(form.sku.trim() === '' ? null : form.sku.trim());
  if (!sku.success) {
    return { ok: false, error: t('catalog.form.invalidSku') };
  }
  let newCategoryName: string | null = null;
  let categoryId: UuidV7 | null = null;
  if (form.categoryId !== '' && form.categoryId !== NEW_CATEGORY) {
    const parsed = UuidV7Schema.safeParse(form.categoryId);
    if (!parsed.success) {
      return { ok: false, error: t('catalog.form.invalidCategory') };
    }
    categoryId = parsed.data;
  }
  if (form.categoryId === NEW_CATEGORY) {
    const parsed = CategoryNameSchema.safeParse(form.newCategoryName);
    if (!parsed.success) {
      return { ok: false, error: t('catalog.form.invalidCategory') };
    }
    newCategoryName = parsed.data;
  }
  const minStock = form.unlimited ? null : parseMinStockInput(form.minStock);
  if (minStock === undefined) {
    return { ok: false, error: t('catalog.form.invalidMinStock') };
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
      barcode: barcodeRaw === '' ? null : barcodeRaw,
      sku: sku.data,
      categoryId,
      newCategoryName,
      unlimited: form.unlimited,
      minStock,
    },
  };
}

function ProductFormModal(props: {
  readonly api: HubApiClient;
  readonly product: ProductSummaryDto | null;
  readonly categories: readonly CategorySummaryDto[];
  readonly defaultVatRateBp: number;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly onError: (err: unknown) => void;
}) {
  const { api, product, categories, defaultVatRateBp, onClose, onSaved, onError } = props;
  const [form, setForm] = useState<ProductFormState>(() => ({
    name: product?.name ?? '',
    unit: product?.unit ?? 'dona',
    salePriceSom: product ? formatTiyinToSom(product.salePrice).replace(/\s/g, '') : '',
    mxik: product?.mxik ?? '',
    packageCode: product?.packageCode ?? '',
    vatPercent: formatVatBpAsPercent(product?.vatRateBp ?? defaultVatRateBp),
    barcode: '',
    sku: product?.sku ?? '',
    categoryId: product?.categoryId ?? '',
    newCategoryName: '',
    unlimited: product?.unlimited ?? false,
    minStock: product?.minStock ? formatMilliToQtyString(product.minStock) : '',
  }));
  const [barcodes, setBarcodes] = useState<readonly ProductBarcodeSummaryDto[]>([]);
  const [extraCategories, setExtraCategories] = useState<readonly CategorySummaryDto[]>([]);
  const allCategories = [...categories, ...extraCategories];
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const productId = product?.id ?? null;

  useEffect(() => {
    if (productId === null) return;
    let cancelled = false;
    api
      .getProduct(productId)
      .then((res) => {
        if (!cancelled) setBarcodes(res.barcodes);
      })
      .catch((err: unknown) => {
        if (!cancelled) onError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [api, productId, onError]);

  const removeBarcode = async (barcodeId: string) => {
    if (productId === null) return;
    try {
      await api.deleteProductBarcode(productId, barcodeId);
      setBarcodes((prev) => prev.filter((b) => b.id !== barcodeId));
    } catch (err) {
      onError(err);
    }
  };

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
      const v = res.value;
      let categoryId = v.categoryId;
      if (v.newCategoryName !== null) {
        // A typed name that already exists reuses that category instead of failing on a duplicate.
        const wanted = v.newCategoryName.toLocaleLowerCase();
        const existing = allCategories.find((c) => c.name.toLocaleLowerCase() === wanted);
        const category =
          existing ?? (await api.createCategory({ name: v.newCategoryName })).category;
        categoryId = category.id;
        if (!existing) setExtraCategories((prev) => [...prev, category]);
        setForm((prev) => ({ ...prev, categoryId: category.id, newCategoryName: '' }));
      }
      const common = {
        name: v.name,
        unit: v.unit,
        salePrice: v.salePrice,
        mxik: v.mxik,
        packageCode: v.packageCode,
        vatRateBp: v.vatRateBp,
        sku: v.sku,
        categoryId,
        unlimited: v.unlimited,
        minStock: v.minStock,
      };
      if (productId !== null) {
        await api.updateProduct(productId, common);
        if (v.barcode !== null) await api.addProductBarcode(productId, { barcode: v.barcode });
      } else {
        await api.createProduct({
          ...common,
          ...(v.barcode !== null ? { barcodes: [{ barcode: v.barcode }] } : {}),
        });
      }
      onSaved();
    } catch (err) {
      // Shown inside the form (the page banner sits behind this modal), in the cashier's language.
      setFormError(describeHubError(err));
    } finally {
      setSaving(false);
    }
  };

  const field = (
    key: 'name' | 'salePriceSom' | 'mxik' | 'packageCode' | 'vatPercent' | 'sku' | 'minStock',
    label: string,
    testId: string,
    extra?: { inputMode?: 'numeric' | 'decimal'; placeholder?: string },
  ) => (
    <label className="pos-form-field">
      <span>{label}</span>
      <input
        className="pos-input"
        data-testid={testId}
        value={form[key]}
        inputMode={extra?.inputMode}
        placeholder={extra?.placeholder}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </label>
  );

  return (
    <div className="pos-modal-backdrop" data-testid="product-form-modal">
      <form className="pos-modal-card pos-product-form" onSubmit={(e) => void handleSubmit(e)}>
        <div className="pos-modal-header">
          <h3 className="pos-modal-title">
            {product ? t('catalog.form.editTitle') : t('catalog.form.createTitle')}
          </h3>
          <button type="button" className="pos-btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
        <div className="pos-modal-body">
          <div className="pos-form-section-title">{t('catalog.form.sectionMain')}</div>
          {field('name', t('catalog.form.name'), 'product-form-name')}

          <label className="pos-form-field">
            <span>{t('catalog.form.barcode')}</span>
            {barcodes.length > 0 && (
              <div className="pos-chip-list" data-testid="product-form-barcodes">
                {barcodes.map((b) => (
                  <span key={b.id} className="pos-chip">
                    {b.barcode}
                    <button
                      type="button"
                      className="pos-chip-remove"
                      aria-label={t('catalog.form.barcodeRemove')}
                      title={t('catalog.form.barcodeRemove')}
                      data-testid={`product-form-barcode-del-${b.id}`}
                      onClick={() => void removeBarcode(b.id)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <input
              className="pos-input"
              data-testid="product-form-barcode"
              value={form.barcode}
              placeholder={
                barcodes.length > 0 ? t('catalog.form.barcodeAdd') : t('catalog.form.barcodeHint')
              }
              autoComplete="off"
              // A scanner ends with Enter: keep it in the field instead of submitting the form.
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault();
              }}
              onChange={(e) => setForm({ ...form, barcode: e.target.value })}
            />
          </label>

          <div className="pos-form-row">
            {field('sku', t('catalog.form.sku'), 'product-form-sku')}
            <label className="pos-form-field">
              <span>{t('catalog.form.category')}</span>
              <select
                className="pos-input"
                data-testid="product-form-category"
                value={form.categoryId}
                onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
              >
                <option value="">{t('catalog.form.noCategory')}</option>
                {allCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value={NEW_CATEGORY}>{t('catalog.form.newCategory')}</option>
              </select>
            </label>
          </div>
          {form.categoryId === NEW_CATEGORY && (
            <label className="pos-form-field">
              <span>{t('catalog.form.newCategoryName')}</span>
              <input
                className="pos-input"
                data-testid="product-form-new-category"
                value={form.newCategoryName}
                onChange={(e) => setForm({ ...form, newCategoryName: e.target.value })}
              />
            </label>
          )}

          <div className="pos-form-row">
            {field('salePriceSom', t('catalog.form.salePrice'), 'product-form-price', {
              inputMode: 'decimal',
            })}
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
                    {t(`unit.${u}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="pos-form-section-title">{t('catalog.form.sectionStock')}</div>
          <label className="pos-check">
            <input
              type="checkbox"
              data-testid="product-form-unlimited"
              checked={form.unlimited}
              onChange={(e) => setForm({ ...form, unlimited: e.target.checked })}
            />
            <span>{t('catalog.form.unlimited')}</span>
          </label>
          {!form.unlimited &&
            field('minStock', t('catalog.form.minStock'), 'product-form-min-stock', {
              inputMode: 'decimal',
            })}

          <details className="pos-form-details" open={Boolean(product?.mxik)}>
            <summary>{t('catalog.form.sectionFiscal')}</summary>
            <div className="pos-form-details-body">
              {field('mxik', t('catalog.form.mxik'), 'product-form-mxik', {
                inputMode: 'numeric',
              })}
              <div className="pos-form-row">
                {field('packageCode', t('catalog.form.packageCode'), 'product-form-package-code', {
                  inputMode: 'numeric',
                })}
                {field('vatPercent', t('catalog.form.vatPercent'), 'product-form-vat', {
                  inputMode: 'decimal',
                })}
              </div>
            </div>
          </details>

          {formError && (
            <div className="pos-error-banner" role="alert" data-testid="product-form-error">
              {formError}
            </div>
          )}
        </div>
        <div className="pos-modal-footer">
          <button type="button" className="pos-btn" onClick={onClose}>
            {t('common.close')}
          </button>
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
      className="pos-modal-body"
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
  /** v1 is internal accounting only (owner 11-20): MXIK nags only when fiscal mode is on. */
  readonly fiscalMode: boolean;
  readonly onClose: () => void;
  readonly onError: (err: unknown) => void;
}) {
  const { api, fiscalMode, onClose, onError } = props;
  const [tab, setTab] = useState<'products' | 'tax'>('products');
  const [query, setQuery] = useState('');
  const [missingOnly, setMissingOnly] = useState(false);
  const [products, setProducts] = useState<readonly ProductSummaryDto[]>([]);
  const [missingCount, setMissingCount] = useState(0);
  const [editing, setEditing] = useState<ProductSummaryDto | 'new' | null>(null);
  const [defaultVatRateBp, setDefaultVatRateBp] = useState(0);
  const [categories, setCategories] = useState<readonly CategorySummaryDto[]>([]);

  const reload = useCallback(async () => {
    try {
      const [list, count, cats] = await Promise.all([
        api.listProducts({
          q: query.trim() === '' ? undefined : query,
          limit: PAGE_SIZE,
          offset: 0,
          missingMxik: missingOnly ? true : undefined,
        }),
        api.countProductsMissingMxik(),
        api.listCategories(),
      ]);
      setProducts(list.products);
      setMissingCount(count.count);
      setCategories(cats.categories);
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
      <div className="pos-modal-card pos-modal-wide">
        <div className="pos-modal-header">
          <h3 className="pos-modal-title">{t('catalog.title')}</h3>
          <div className="pos-tabs">
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

        <div className="pos-modal-body">
          {tab === 'tax' ? (
            <TaxSettingsPanel api={api} onError={onError} onSaved={setDefaultVatRateBp} />
          ) : (
            <>
              {fiscalMode && missingCount > 0 && (
                <div
                  className="pos-warning-banner"
                  role="status"
                  data-testid="missing-mxik-warning"
                >
                  {t('catalog.missingMxikWarning', { count: missingCount })}
                </div>
              )}
              <div className="pos-toolbar-row">
                <input
                  className="pos-input"
                  data-testid="catalog-search"
                  placeholder={t('catalog.searchPlaceholder')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {fiscalMode && (
                  <>
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
                  </>
                )}
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
                      <th>{t('catalog.col.code')}</th>
                      <th>{t('catalog.col.category')}</th>
                      <th className="pos-num">{t('catalog.col.price')}</th>
                      {fiscalMode && <th>{t('catalog.col.mxik')}</th>}
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p) => (
                      <tr key={p.id} data-testid={`catalog-row-${p.id}`}>
                        <td>
                          <strong>{p.name}</strong>
                        </td>
                        <td className="pos-muted">{p.sku ?? '—'}</td>
                        <td className="pos-muted">
                          {categories.find((c) => c.id === p.categoryId)?.name ?? '—'}
                        </td>
                        <td className="pos-num">
                          {formatTiyinToSom(p.salePrice)} {t('common.currency')}
                        </td>
                        {fiscalMode && (
                          <td className="pos-muted">{p.mxik ?? t('catalog.noMxik')}</td>
                        )}
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
          categories={categories}
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
