import type { PriceTierDto, ProductSummaryDto } from '@mezon/contracts';
import type { UuidV7 } from '@mezon/domain';
import { t } from '@mezon/i18n';
import { formatMilliToQtyString, formatTiyinToSom, stepMilliQuantity } from '@mezon/ui';
import { type KeyboardEvent, type RefObject, useEffect, useState } from 'react';
import type { HubApiClient } from '../api/hub-client.js';
import { usePosStore } from '../store/pos-store.js';
import { Icon, type IconName } from './Icon.js';
import { splitHotkey } from './SideNav.js';
import { LiveScanOverlay } from './LiveScanOverlay.js';
import type { ScanResult } from '../utils/live-scan.js';
import { WHOLESALE_LINE_NAME, tierHint } from '../utils/price-tiers.js';

/** Soft tile colours: the same product always gets the same one (by name). */
const TILE_TONES = 6;
function toneOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h % TILE_TONES;
}

function ActionLabel({ icon, label }: { readonly icon: IconName; readonly label: string }) {
  const [text, key] = splitHotkey(label);
  return (
    <>
      <Icon name={icon} />
      <span className="pos-action-text">{text}</span>
      {key !== null && <kbd className="pos-kbd">{key}</kbd>}
    </>
  );
}

export function PosWorkspaceScreen({
  api,
  searchInputRef,
  onSearchProducts,
  onOpenParkedModal,
  onOpenCustomerModal,
  onScanBarcode,
  onLinkBarcode,
  onError,
}: {
  readonly api: HubApiClient;
  readonly searchInputRef: RefObject<HTMLInputElement | null>;
  readonly onSearchProducts: (q: string, categoryId: UuidV7 | null) => Promise<void>;
  readonly onOpenParkedModal: () => Promise<void>;
  readonly onOpenCustomerModal: () => Promise<void>;
  readonly onScanBarcode: (barcode: string) => Promise<ScanResult>;
  /** C19: owner/manager may link an unknown scanned code to a product (null for a cashier). */
  readonly onLinkBarcode: ((barcode: string) => void) | null;
  readonly onError: (err: unknown) => void;
}) {
  const scanBarcode = window.mezonBridge?.scanBarcode;
  const startLiveScan = window.mezonBridge?.startLiveScan;
  const [cameraBusy, setCameraBusy] = useState(false);
  // C19: the phone keeps the camera open and scans item after item.
  const [liveOpen, setLiveOpen] = useState(false);
  const scanWithCamera = async () => {
    if (startLiveScan !== undefined) {
      setLiveOpen(true);
      return;
    }
    if (scanBarcode === undefined || cameraBusy) return;
    setCameraBusy(true);
    try {
      const code = await scanBarcode();
      if (code !== null) await onScanBarcode(code);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      onError(
        message === 'CAMERA_PERMISSION_DENIED'
          ? new Error(t('pos.camera.permissionDenied'))
          : message === 'SCANNER_MODULE_INSTALLING'
            ? new Error(t('pos.camera.installing'))
            : err,
      );
    } finally {
      setCameraBusy(false);
    }
  };
  const activeCart = usePosStore((s) => s.activeCart);
  const setActiveCart = usePosStore((s) => s.setActiveCart);
  const parkedCarts = usePosStore((s) => s.parkedCarts);
  const selectedLineId = usePosStore((s) => s.selectedLineId);
  const setSelectedLineId = usePosStore((s) => s.setSelectedLineId);
  const selectedCustomer = usePosStore((s) => s.selectedCustomer);
  const categories = usePosStore((s) => s.categories);
  const selectedCategoryId = usePosStore((s) => s.selectedCategoryId);
  const setSelectedCategoryId = usePosStore((s) => s.setSelectedCategoryId);
  const searchQuery = usePosStore((s) => s.searchQuery);
  const setSearchQuery = usePosStore((s) => s.setSearchQuery);
  const searchResults = usePosStore((s) => s.searchResults);
  const lastScannedBarcode = usePosStore((s) => s.lastScannedBarcode);
  const shortLineIds = usePosStore((s) => s.shortLineIds);
  const insufficientLines = usePosStore((s) => s.insufficientLines);
  const setActiveModal = usePosStore((s) => s.setActiveModal);

  const [focusedResultIdx, setFocusedResultIdx] = useState(0);

  // C20: starred goods (per store) and the "Sevimlilar" filter.
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(new Set());
  const [favMode, setFavMode] = useState(false);
  const [favResults, setFavResults] = useState<readonly ProductSummaryDto[]>([]);
  // C20: wholesale tiers of the goods on screen, by product id.
  const [tiersByProduct, setTiersByProduct] = useState<
    ReadonlyMap<string, readonly PriceTierDto[]>
  >(new Map());

  useEffect(() => {
    let alive = true;
    api
      .listFavorites()
      .then((r) => {
        if (alive) setFavoriteIds(new Set(r.productIds));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);

  const shownResults = favMode ? favResults : searchResults;

  useEffect(() => {
    if (!favMode) return;
    let alive = true;
    api
      .listProducts({ q: searchQuery, favoritesOnly: true, limit: 100 })
      .then((r) => {
        if (alive) setFavResults(r.products);
      })
      .catch(onError);
    return () => {
      alive = false;
    };
  }, [api, favMode, searchQuery, favoriteIds, onError]);

  const shownIdsKey = shownResults.map((p) => p.id).join(',');
  useEffect(() => {
    if (shownIdsKey.length === 0) return;
    let alive = true;
    api
      .listPriceTiers(shownIdsKey.split(','))
      .then((r) => {
        if (!alive) return;
        const map = new Map<string, PriceTierDto[]>();
        for (const tier of r.tiers) {
          const list = map.get(tier.productId) ?? [];
          list.push(tier);
          map.set(tier.productId, list);
        }
        setTiersByProduct(map);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, shownIdsKey]);

  const toggleFavorite = async (productId: string) => {
    try {
      const res = await api.setFavorite(productId, !favoriteIds.has(productId));
      setFavoriteIds(new Set(res.productIds));
    } catch (err) {
      onError(err);
    }
  };

  const handleAddProduct = async (product: ProductSummaryDto) => {
    if (!activeCart) {
      return;
    }
    try {
      const res = await api.addCartLine(activeCart.id, {
        kind: 'catalog',
        productId: product.id,
        variantId: null,
        qty: '1000',
      });
      setActiveCart(res.cart);
    } catch (err) {
      onError(err);
    }
  };

  const handleStepLineQty = async (lineId: UuidV7, currentQty: string, delta: 1 | -1) => {
    if (!activeCart) {
      return;
    }
    const nextQty = stepMilliQuantity(currentQty, delta);
    if (nextQty === currentQty) {
      return;
    }
    try {
      const res = await api.updateCartLine(activeCart.id, lineId, {
        qty: nextQty,
      });
      setActiveCart(res.cart);
    } catch (err) {
      onError(err);
    }
  };

  const handleRemoveLine = async (lineId: UuidV7) => {
    if (!activeCart) {
      return;
    }
    try {
      const res = await api.removeCartLine(activeCart.id, lineId);
      setActiveCart(res.cart);
    } catch (err) {
      onError(err);
    }
  };

  const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedResultIdx((prev) => Math.min(Math.max(0, shownResults.length - 1), prev + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedResultIdx((prev) => Math.max(0, prev - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = shownResults[focusedResultIdx] ?? shownResults[0];
      if (target) {
        void handleAddProduct(target);
      } else {
        void onSearchProducts(searchQuery, selectedCategoryId);
      }
    }
  };

  const lines = activeCart?.lines ?? [];
  // The discount column is shown only when some line actually has a discount.
  const anyLineDiscount = lines.some(
    (l) => BigInt(l.promoDiscount) + BigInt(l.allocatedOrderDiscount) > 0n,
  );

  return (
    <div className="pos-workspace" data-testid="pos-workspace">
      {/* Left Pane: Active Cart & Totals */}
      <div className="pos-pane">
        <div className="pos-top-actions">
          <span className="pos-telemetry-item" data-testid="scanner-ready-indicator">
            {lastScannedBarcode
              ? t('pos.lastScan', { code: lastScannedBarcode })
              : t('pos.scannerReady')}
          </span>
          {selectedCustomer && (
            <span className="pos-telemetry-item" data-testid="selected-customer-badge">
              {selectedCustomer.fullName}
            </span>
          )}
        </div>

        {insufficientLines.length > 0 && (
          <div className="pos-error-banner" data-testid="insufficient-stock-list">
            <div>
              <strong>{t('error.INSUFFICIENT_STOCK')}</strong>
              <ul>
                {insufficientLines.map((item) => (
                  <li key={item.cartLineId}>
                    {item.itemName}: {formatMilliToQtyString(item.requestedQty)} /{' '}
                    {formatMilliToQtyString(item.availableQty)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <div className="pos-cart-table-wrap">
          {lines.length === 0 ? (
            <div className="pos-empty-state" data-testid="cart-empty-message">
              <span className="pos-empty-icon" aria-hidden="true">
                <Icon name="scan" />
              </span>
              <p>{t('pos.cartEmpty')}</p>
            </div>
          ) : (
            <table className="pos-cart-table" data-testid="cart-lines-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('pos.colItem')}</th>
                  <th>{t('pos.colQty')}</th>
                  {anyLineDiscount && <th className="pos-line-discount">{t('pos.colDiscount')}</th>}
                  <th>{t('pos.colTotal')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => {
                  const isSelected = line.id === selectedLineId;
                  const isShort = shortLineIds.has(line.id);
                  const lineDiscount =
                    BigInt(line.promoDiscount) + BigInt(line.allocatedOrderDiscount);
                  return (
                    <tr
                      key={line.id}
                      data-testid={`cart-line-row-${String(index)}`}
                      className={`pos-cart-row ${isSelected ? 'pos-cart-row-selected' : ''} ${isShort ? 'pos-cart-row-short' : ''}`}
                      onClick={() => setSelectedLineId(line.id)}
                    >
                      <td>{index + 1}</td>
                      <td className="pos-line-item">
                        <span
                          className="pos-line-name"
                          data-testid={`cart-line-name-${String(index)}`}
                        >
                          {line.name}
                        </span>
                        {line.appliedPromotionName === WHOLESALE_LINE_NAME ? (
                          <span className="pos-line-price">
                            {formatTiyinToSom(
                              (
                                (BigInt(line.subtotalAfterPromo) * 1000n) /
                                BigInt(line.qty)
                              ).toString(),
                            )}{' '}
                            {t('common.currency')} / {t(`unit.${line.unit}`)}{' '}
                            <s className="pos-line-old-price">
                              {formatTiyinToSom(line.unitPriceSnapshot)}
                            </s>
                            <span
                              className="pos-wholesale-tag"
                              data-testid={`cart-line-wholesale-${String(index)}`}
                            >
                              {t('pos.wholesale.tag')}
                            </span>
                          </span>
                        ) : (
                          <span className="pos-line-price">
                            {formatTiyinToSom(line.unitPriceSnapshot)} {t('common.currency')} /{' '}
                            {t(`unit.${line.unit}`)}
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="pos-qty-controls">
                          <button
                            type="button"
                            className="pos-btn pos-qty-step"
                            data-testid={`cart-line-dec-${String(index)}`}
                            aria-label={t('pos.qtyDecrease')}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleStepLineQty(line.id, line.qty, -1);
                            }}
                          >
                            <Icon name="minus" />
                          </button>
                          <button
                            type="button"
                            className="pos-btn pos-qty-value"
                            data-testid={`cart-line-qty-${String(index)}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedLineId(line.id);
                              setActiveModal('edit_qty');
                            }}
                          >
                            {formatMilliToQtyString(line.qty)} {t(`unit.${line.unit}`)}
                          </button>
                          <button
                            type="button"
                            className="pos-btn pos-qty-step"
                            data-testid={`cart-line-inc-${String(index)}`}
                            aria-label={t('pos.qtyIncrease')}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleStepLineQty(line.id, line.qty, 1);
                            }}
                          >
                            <Icon name="plus" />
                          </button>
                        </div>
                      </td>
                      {anyLineDiscount && (
                        <td className="pos-line-discount">
                          {lineDiscount > 0n ? `−${formatTiyinToSom(lineDiscount)}` : '—'}
                        </td>
                      )}
                      <td data-testid={`cart-line-total-${String(index)}`}>
                        <strong>{formatTiyinToSom(line.finalTotal)}</strong>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="pos-btn pos-btn-danger-soft pos-line-del"
                          data-testid={`cart-line-del-${String(index)}`}
                          aria-label={t('pos.removeLine')}
                          title={t('pos.removeLine')}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleRemoveLine(line.id);
                          }}
                        >
                          <Icon name="trash" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="pos-totals-box">
          {(() => {
            const promo = activeCart?.totalPromoDiscount ?? '0';
            const manual = activeCart?.effectiveOrderDiscount ?? '0';
            const vat = activeCart?.totalVat ?? '0';
            const gross = activeCart?.subtotalGross ?? '0';
            const anyAdjustment = promo !== '0' || manual !== '0' || vat !== '0';
            return (
              <>
                {anyAdjustment && (
                  <div className="pos-totals-row">
                    <span>{t('pos.subtotalGross')}</span>
                    <span data-testid="cart-subtotal-gross">
                      {formatTiyinToSom(gross)} {t('common.currency')}
                    </span>
                  </div>
                )}
                {promo !== '0' && (
                  <div className="pos-totals-row pos-totals-discount">
                    <span>{t('pos.promoDiscount')}</span>
                    <span data-testid="cart-promo-discount">
                      −{formatTiyinToSom(promo)} {t('common.currency')}
                    </span>
                  </div>
                )}
                {manual !== '0' && (
                  <div className="pos-totals-row pos-totals-discount">
                    <span>{t('pos.manualDiscount')}</span>
                    <span data-testid="cart-manual-discount">
                      −{formatTiyinToSom(manual)} {t('common.currency')}
                    </span>
                  </div>
                )}
                {vat !== '0' && (
                  <div className="pos-totals-row">
                    <span>{t('pos.vatTotal')}</span>
                    <span data-testid="cart-vat-total">
                      {formatTiyinToSom(vat)} {t('common.currency')}
                    </span>
                  </div>
                )}
              </>
            );
          })()}
          <div className="pos-totals-grand">
            <span>{t('pos.totalPayable')}</span>
            <span data-testid="cart-total-final">
              {formatTiyinToSom(activeCart?.totalFinal ?? '0')} {t('common.currency')}
            </span>
          </div>
        </div>

        <div className="pos-action-grid">
          <button
            type="button"
            className="pos-btn pos-action"
            data-testid="pos-quick-sale-btn"
            onClick={() => setActiveModal('quick_sale')}
          >
            <ActionLabel icon="bolt" label={t('pos.quickSaleBtn')} />
          </button>
          <button
            type="button"
            className="pos-btn pos-action"
            data-testid="pos-discount-btn"
            disabled={lines.length === 0}
            onClick={() => setActiveModal('discount')}
          >
            <ActionLabel icon="percent" label={t('pos.discountBtn')} />
          </button>
          <button
            type="button"
            className="pos-btn pos-action"
            data-testid="pos-park-btn"
            disabled={lines.length === 0}
            onClick={() => setActiveModal('park_cart')}
          >
            <ActionLabel icon="pause" label={t('pos.parkBtn')} />
          </button>
          <button
            type="button"
            className="pos-btn pos-action"
            data-testid="pos-parked-list-btn"
            onClick={() => void onOpenParkedModal()}
          >
            <ActionLabel icon="stack" label={t('pos.parkedListBtn')} />
            {parkedCarts.length > 0 && <span className="pos-count">{parkedCarts.length}</span>}
          </button>
          <button
            type="button"
            className="pos-btn pos-action"
            data-testid="pos-customer-btn"
            onClick={() => void onOpenCustomerModal()}
          >
            <ActionLabel icon="user" label={t('pos.customerBtn')} />
          </button>
          <button
            type="button"
            className="pos-btn pos-btn-success pos-pay-btn"
            data-testid="pos-pay-btn"
            disabled={lines.length === 0}
            onClick={() => setActiveModal('payment')}
          >
            <ActionLabel icon="wallet" label={t('pos.payBtn')} />
          </button>
        </div>
      </div>

      {liveOpen && startLiveScan !== undefined && (
        <LiveScanOverlay
          startLiveScan={startLiveScan}
          onScan={onScanBarcode}
          onClose={() => setLiveOpen(false)}
          onFinish={() => {
            setLiveOpen(false);
            setActiveModal('payment');
          }}
          onLink={
            onLinkBarcode === null
              ? null
              : (code) => {
                  setLiveOpen(false);
                  onLinkBarcode(code);
                }
          }
          onError={onError}
        />
      )}

      {/* Right Pane: Catalog Search & Category Filter */}
      <div className="pos-pane">
        <div className="pos-search-bar">
          {scanBarcode !== undefined && (
            <button
              type="button"
              className="pos-btn pos-btn-primary pos-camera-btn"
              data-testid="camera-scan-btn"
              disabled={cameraBusy}
              onClick={() => void scanWithCamera()}
              aria-label={t('pos.camera.scan')}
              title={t('pos.camera.scan')}
            >
              <Icon name="scan" />
              <span className="pos-camera-label">{t('pos.camera.scan')}</span>
            </button>
          )}
          <label className="pos-search-field">
            <Icon name="search" />
            <input
              ref={searchInputRef}
              className="pos-input"
              data-testid="catalog-search-input"
              placeholder={t('pos.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => {
                const q = e.target.value;
                setSearchQuery(q);
                setFocusedResultIdx(0);
                void onSearchProducts(q, selectedCategoryId);
              }}
              onKeyDown={handleSearchKeyDown}
            />
          </label>
        </div>

        <div className="pos-chips" role="tablist" data-testid="catalog-category-select">
          <button
            type="button"
            role="tab"
            aria-selected={favMode}
            data-testid="catalog-favorites-chip"
            className={`pos-chip pos-chip-fav ${favMode ? 'pos-chip-active' : ''}`}
            onClick={() => {
              setFavMode((v) => !v);
              setFocusedResultIdx(0);
            }}
          >
            <Icon name="star" />
            {t('pos.favorites.chip')}
            {favoriteIds.size > 0 && <span className="pos-count">{favoriteIds.size}</span>}
          </button>
          {categories.length > 0 &&
            [{ id: null, name: t('pos.allCategories') }, ...categories].map((cat) => {
              const active = !favMode && (cat.id ?? null) === (selectedCategoryId ?? null);
              return (
                <button
                  key={cat.id ?? 'all'}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`pos-chip ${active ? 'pos-chip-active' : ''}`}
                  onClick={() => {
                    const nextCat = cat.id ?? null;
                    setFavMode(false);
                    setSelectedCategoryId(nextCat);
                    setFocusedResultIdx(0);
                    void onSearchProducts(searchQuery, nextCat);
                  }}
                >
                  {cat.name}
                </button>
              );
            })}
        </div>

        <div className="pos-product-list" data-testid="catalog-search-results">
          {shownResults.length === 0 ? (
            <p data-testid="catalog-no-results">
              {favMode ? t('pos.favorites.empty') : t('pos.noSearchResults')}
            </p>
          ) : (
            shownResults.map((prod, idx) => {
              const isFav = favoriteIds.has(prod.id);
              const hint = tierHint(tiersByProduct.get(prod.id));
              return (
                <div key={prod.id} className="pos-product-cell">
                  <button
                    type="button"
                    className={`pos-product-item ${idx === focusedResultIdx ? 'pos-cart-row-selected' : ''}`}
                    data-testid={`catalog-result-${String(idx)}`}
                    onClick={() => void handleAddProduct(prod)}
                  >
                    <span
                      className={`pos-tile-badge pos-tone-${String(toneOf(prod.name))}`}
                      aria-hidden="true"
                    >
                      {prod.name.trim().charAt(0).toUpperCase()}
                    </span>
                    <span className="pos-tile-name">
                      {prod.name}
                      {prod.sku ? <small> · {prod.sku}</small> : null}
                    </span>
                    <span className="pos-tile-price">
                      <strong>
                        {formatTiyinToSom(prod.salePrice)} {t('common.currency')}
                      </strong>
                      <small> / {t(`unit.${prod.unit}`)}</small>
                      {hint !== null && (
                        <small
                          className="pos-tile-tier"
                          data-testid={`catalog-result-tier-${String(idx)}`}
                        >
                          {t('pos.wholesale.hint', {
                            qty: hint.qty,
                            unit: t(`unit.${prod.unit}`),
                            price: formatTiyinToSom(hint.price),
                          })}
                        </small>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`pos-fav-btn ${isFav ? 'pos-fav-on' : ''}`}
                    data-testid={`catalog-result-fav-${String(idx)}`}
                    aria-pressed={isFav}
                    aria-label={isFav ? t('pos.favorites.remove') : t('pos.favorites.add')}
                    title={isFav ? t('pos.favorites.remove') : t('pos.favorites.add')}
                    onClick={() => void toggleFavorite(prod.id)}
                  >
                    <Icon name="star" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
