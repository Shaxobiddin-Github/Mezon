import type { ProductSummaryDto } from '@mezon/contracts';
import type { UuidV7 } from '@mezon/domain';
import { t } from '@mezon/i18n';
import { formatMilliToQtyString, formatTiyinToSom, stepMilliQuantity } from '@mezon/ui';
import { type KeyboardEvent, type RefObject, useState } from 'react';
import type { HubApiClient } from '../api/hub-client.js';
import { usePosStore } from '../store/pos-store.js';

export function PosWorkspaceScreen({
  api,
  searchInputRef,
  onSearchProducts,
  onOpenParkedModal,
  onOpenCustomerModal,
  onError,
}: {
  readonly api: HubApiClient;
  readonly searchInputRef: RefObject<HTMLInputElement | null>;
  readonly onSearchProducts: (q: string, categoryId: UuidV7 | null) => Promise<void>;
  readonly onOpenParkedModal: () => Promise<void>;
  readonly onOpenCustomerModal: () => Promise<void>;
  readonly onError: (err: unknown) => void;
}) {
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
      setFocusedResultIdx((prev) => Math.min(Math.max(0, searchResults.length - 1), prev + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedResultIdx((prev) => Math.max(0, prev - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = searchResults[focusedResultIdx] ?? searchResults[0];
      if (target) {
        void handleAddProduct(target);
      } else {
        void onSearchProducts(searchQuery, selectedCategoryId);
      }
    }
  };

  const lines = activeCart?.lines ?? [];

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
            <p data-testid="cart-empty-message">{t('pos.cartEmpty')}</p>
          ) : (
            <table className="pos-cart-table" data-testid="cart-lines-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('pos.colItem')}</th>
                  <th>{t('pos.colQty')}</th>
                  <th>{t('pos.colPrice')}</th>
                  <th>{t('pos.colDiscount')}</th>
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
                      <td data-testid={`cart-line-name-${String(index)}`}>{line.name}</td>
                      <td>
                        <div className="pos-qty-controls">
                          <button
                            type="button"
                            className="pos-btn"
                            data-testid={`cart-line-dec-${String(index)}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleStepLineQty(line.id, line.qty, -1);
                            }}
                          >
                            -
                          </button>
                          <button
                            type="button"
                            className="pos-btn"
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
                            className="pos-btn"
                            data-testid={`cart-line-inc-${String(index)}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleStepLineQty(line.id, line.qty, 1);
                            }}
                          >
                            +
                          </button>
                        </div>
                      </td>
                      <td>{formatTiyinToSom(line.unitPriceSnapshot)}</td>
                      <td>{lineDiscount > 0n ? `-${formatTiyinToSom(lineDiscount)}` : '0'}</td>
                      <td data-testid={`cart-line-total-${String(index)}`}>
                        <strong>{formatTiyinToSom(line.finalTotal)}</strong>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="pos-btn pos-btn-danger"
                          data-testid={`cart-line-del-${String(index)}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleRemoveLine(line.id);
                          }}
                        >
                          ×
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
          <div className="pos-totals-row">
            <span>{t('pos.subtotalGross')}:</span>
            <span data-testid="cart-subtotal-gross">
              {formatTiyinToSom(activeCart?.subtotalGross ?? '0')} {t('common.currency')}
            </span>
          </div>
          <div className="pos-totals-row">
            <span>{t('pos.promoDiscount')}:</span>
            <span data-testid="cart-promo-discount">
              -{formatTiyinToSom(activeCart?.totalPromoDiscount ?? '0')} {t('common.currency')}
            </span>
          </div>
          <div className="pos-totals-row">
            <span>{t('pos.manualDiscount')}:</span>
            <span data-testid="cart-manual-discount">
              -{formatTiyinToSom(activeCart?.effectiveOrderDiscount ?? '0')} {t('common.currency')}
            </span>
          </div>
          <div className="pos-totals-row">
            <span>{t('pos.vatTotal')}:</span>
            <span data-testid="cart-vat-total">
              {formatTiyinToSom(activeCart?.totalVat ?? '0')} {t('common.currency')}
            </span>
          </div>
          <div className="pos-totals-grand">
            <span>{t('pos.totalPayable')}:</span>
            <span data-testid="cart-total-final">
              {formatTiyinToSom(activeCart?.totalFinal ?? '0')} {t('common.currency')}
            </span>
          </div>
        </div>

        <div className="pos-action-grid">
          <button
            type="button"
            className="pos-btn"
            data-testid="pos-quick-sale-btn"
            onClick={() => setActiveModal('quick_sale')}
          >
            {t('pos.quickSaleBtn')}
          </button>
          <button
            type="button"
            className="pos-btn"
            data-testid="pos-discount-btn"
            disabled={lines.length === 0}
            onClick={() => setActiveModal('discount')}
          >
            {t('pos.discountBtn')}
          </button>
          <button
            type="button"
            className="pos-btn"
            data-testid="pos-park-btn"
            disabled={lines.length === 0}
            onClick={() => setActiveModal('park_cart')}
          >
            {t('pos.parkBtn')}
          </button>
          <button
            type="button"
            className="pos-btn"
            data-testid="pos-parked-list-btn"
            onClick={() => void onOpenParkedModal()}
          >
            {t('pos.parkedListBtn')} ({parkedCarts.length})
          </button>
          <button
            type="button"
            className="pos-btn"
            data-testid="pos-customer-btn"
            onClick={() => void onOpenCustomerModal()}
          >
            {t('pos.customerBtn')}
          </button>
          <button
            type="button"
            className="pos-btn pos-btn-success"
            data-testid="pos-pay-btn"
            disabled={lines.length === 0}
            onClick={() => setActiveModal('payment')}
          >
            {t('pos.payBtn')}
          </button>
        </div>
      </div>

      {/* Right Pane: Catalog Search & Category Filter */}
      <div className="pos-pane">
        <div className="pos-search-bar">
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
          <select
            className="pos-select"
            data-testid="catalog-category-select"
            value={selectedCategoryId ?? ''}
            onChange={(e) => {
              const nextCat = e.target.value.length > 0 ? (e.target.value as UuidV7) : null;
              setSelectedCategoryId(nextCat);
              setFocusedResultIdx(0);
              void onSearchProducts(searchQuery, nextCat);
            }}
          >
            <option value="">{t('pos.allCategories')}</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
          </select>
        </div>

        <div className="pos-product-list" data-testid="catalog-search-results">
          {searchResults.length === 0 ? (
            <p data-testid="catalog-no-results">{t('pos.noSearchResults')}</p>
          ) : (
            searchResults.map((prod, idx) => (
              <button
                key={prod.id}
                type="button"
                className={`pos-product-item ${idx === focusedResultIdx ? 'pos-cart-row-selected' : ''}`}
                data-testid={`catalog-result-${String(idx)}`}
                onClick={() => void handleAddProduct(prod)}
              >
                <div>
                  <strong>{prod.name}</strong>
                  {prod.sku ? ` (${prod.sku})` : ''}
                </div>
                <div>
                  <strong>
                    {formatTiyinToSom(prod.salePrice)} {t('common.currency')}
                  </strong>{' '}
                  / {t(`unit.${prod.unit}`)}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
