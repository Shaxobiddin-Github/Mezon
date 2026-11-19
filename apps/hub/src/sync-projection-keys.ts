import { parseUuidV7, type UuidV7 } from '@mezon/domain';

/**
 * T2.6: projection keys touched by the events a pull batch actually applied. Only these are
 * recomputed (`recompute*`), with the same code the full rebuild uses — so a partial result equals a
 * full rebuild. Stock pools are recomputed per product (all of its variants): a superset of the
 * touched (product, variant) pools, which keeps the key simple and is still correct.
 */
export class ProjectionTouchSet {
  readonly productIds = new Set<UuidV7>();
  readonly customerIds = new Set<UuidV7>();
  readonly supplierIds = new Set<UuidV7>();

  get isEmpty(): boolean {
    return this.productIds.size === 0 && this.customerIds.size === 0 && this.supplierIds.size === 0;
  }
}

function idOf(value: unknown): UuidV7 | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return parseUuidV7(value);
  } catch {
    return null;
  }
}

function add(set: Set<UuidV7>, value: unknown): void {
  const id = idOf(value);
  if (id !== null) set.add(id);
}

/**
 * Which projection rows an applied event can change. Single source of truth for the pull path:
 * - stock pools replay `stock_moves`, `receiving_cost_confirmations`, the `cost_unknown` flag of
 *   `goods_receiving_lines`, batch rows and the product's `track_batches` flag;
 * - customer / supplier balances replay their ledger; a new customer / supplier gets a (zero) row.
 */
export function collectTouchedProjectionKeys(
  touch: ProjectionTouchSet,
  entity: string,
  entityId: string,
  payload: Readonly<Record<string, unknown>>,
): void {
  switch (entity) {
    case 'stock_moves':
    case 'batches':
    case 'receiving_cost_confirmations':
    case 'goods_receiving_lines':
      add(touch.productIds, payload.productId);
      return;
    case 'products':
      add(touch.productIds, entityId);
      return;
    case 'customer_ledger':
      add(touch.customerIds, payload.customerId);
      return;
    case 'customers':
      add(touch.customerIds, entityId);
      return;
    case 'supplier_ledger':
      add(touch.supplierIds, payload.supplierId);
      return;
    case 'suppliers':
      add(touch.supplierIds, entityId);
      return;
    default:
      return;
  }
}
