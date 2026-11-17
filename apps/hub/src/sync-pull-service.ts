import {
  type SyncedEventDto,
  CURRENT_SCHEMA_VERSION,
  MONOTONE_TRANSITION_RULES,
  validateSyncEntityPayload,
  type MonotoneTransitionRule,
} from '@mezon/sync';
import { type UnixMs, type UuidV7, type IdGenerator, parseUuidV7 } from '@mezon/domain';
import { createSystemUuidV7Generator } from '@mezon/drivers';
import {
  getTableColumns,
  localSchemaRegistry,
  type SqliteTableMetadata,
  buildSqliteForeignReferencesMap,
  type SqliteForeignKeyRef,
  type LocalSqliteConnection,
  executeStockProjectionsRebuildSync,
  recomputeCustomerBalancesForIdsSync,
  recomputeSupplierBalancesForIdsSync,
} from '@mezon/db-local';
import { ProjectionTouchSet, collectTouchedProjectionKeys } from './sync-projection-keys.js';

/** P1/S6 conflict reasons raised by the pull itself (view / acknowledge only). */
export const PROJECTION_FAILED = 'PROJECTION_FAILED';
export const CUSTOMER_OVERPAID = 'CUSTOMER_OVERPAID';
const STOCK_PROJECTION = 'local_stock_balances';
const CUSTOMER_PROJECTION = 'local_customer_balances';
const SUPPLIER_PROJECTION = 'local_supplier_balances';

export class PermanentSyncError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentSyncError';
  }
}

export type SqliteSyncErrorCategory =
  | { readonly type: 'permanent'; readonly code: string; readonly message: string }
  | { readonly type: 'park_foreign_key'; readonly code: string; readonly message: string }
  | { readonly type: 'transient'; readonly code?: string; readonly message: string };

export function classifySyncError(err: unknown): SqliteSyncErrorCategory {
  if (err instanceof PermanentSyncError) {
    return { type: 'permanent', code: err.reason, message: err.message };
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = String(err.code);
    if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      return { type: 'park_foreign_key', code, message: msg };
    }
    if (code.startsWith('SQLITE_CONSTRAINT')) {
      return { type: 'permanent', code: `LOCAL_CONSTRAINT_FAILED:${code}`, message: msg };
    }
    if (
      code === 'SQLITE_BUSY' ||
      code === 'SQLITE_IOERR' ||
      code === 'SQLITE_FULL' ||
      code === 'SQLITE_LOCKED' ||
      code === 'SQLITE_NOMEM' ||
      code === 'SQLITE_CORRUPT'
    ) {
      return { type: 'transient', code, message: msg };
    }
  }
  if (/FOREIGN KEY constraint failed/i.test(msg)) {
    return { type: 'park_foreign_key', code: 'SQLITE_CONSTRAINT_FOREIGNKEY', message: msg };
  }
  if (
    /CHECK constraint failed|NOT NULL constraint failed|UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(
      msg,
    )
  ) {
    return { type: 'permanent', code: 'LOCAL_CONSTRAINT_FAILED', message: msg };
  }
  return { type: 'transient', message: msg };
}

export interface SyncApplyBatchResult {
  readonly appliedCount: number;
  readonly skippedEchoCount: number;
  readonly parkedCount: number;
  readonly conflictCount: number;
  readonly nextCursors: Record<string, string>;
}

function toComparableString(val: unknown): string {
  if (val === null || val === undefined) {
    return '';
  }
  if (typeof val === 'string') {
    return val;
  }
  if (typeof val === 'number' || typeof val === 'bigint' || typeof val === 'boolean') {
    return val.toString();
  }
  return JSON.stringify(val);
}

export class HubSyncPullService {
  private readonly sqlite: LocalSqliteConnection['sqlite'];
  private readonly foreignRefsMap: Record<string, readonly SqliteForeignKeyRef[]>;

  constructor(
    private readonly connection: LocalSqliteConnection,
    private readonly idGen: IdGenerator = createSystemUuidV7Generator(),
  ) {
    this.sqlite = connection.sqlite;
    this.foreignRefsMap = buildSqliteForeignReferencesMap(localSchemaRegistry);
  }

  getCursors(organizationId: UuidV7): Record<string, bigint> {
    const rows = this.sqlite
      .prepare('SELECT store_id, last_position FROM local_sync_cursors WHERE organization_id = ?')
      .all(organizationId) as Array<{ store_id: string; last_position: number | bigint }>;

    const map: Record<string, bigint> = {};
    for (const row of rows) {
      map[row.store_id] = BigInt(row.last_position);
    }
    return map;
  }

  getApplyState(): { inSync: number } {
    const row = this.sqlite
      .prepare('SELECT in_sync FROM local_sync_apply_state WHERE id = ?')
      .get('singleton') as { in_sync: number | bigint } | undefined;
    return { inSync: Number(row?.in_sync ?? 0) };
  }

  applySyncPullBatch(params: {
    readonly context: {
      readonly organizationId: UuidV7;
      readonly storeId: UuidV7;
      readonly deviceId: UuidV7;
    };
    readonly events: readonly SyncedEventDto[];
    readonly nextCursors: Record<string, bigint>;
    readonly nowMs: UnixMs;
  }): SyncApplyBatchResult {
    let appliedCount = 0;
    let skippedEchoCount = 0;
    let parkedCount = 0;
    let conflictCount = 0;
    const touch = new ProjectionTouchSet();

    const executeTx = this.sqlite.transaction(() => {
      // T1: Set in_sync = 1 in main schema table
      this.sqlite
        .prepare(
          "UPDATE local_sync_apply_state SET in_sync = 1, updated_at_ms = ? WHERE id = 'singleton'",
        )
        .run(params.nowMs);

      try {
        for (let i = 0; i < params.events.length; i++) {
          const event = params.events[i];
          const spName = `sp_pull_${i}`;
          this.sqlite.exec(`SAVEPOINT ${spName}`);

          try {
            // 1. T2 Echo check: only skip if eventId is in local_outbox (where id = eventId)
            const isInOutbox = this.sqlite
              .prepare('SELECT 1 FROM local_outbox WHERE id = ? LIMIT 1')
              .get(event.eventId);

            if (isInOutbox) {
              if (event.hlcAdjusted) {
                this.clampLocalRowHlc(event, params.nowMs);
              }
              this.sqlite.exec(`RELEASE SAVEPOINT ${spName}`);
              skippedEchoCount++;
              continue;
            }

            // 2. Strict payload validation (T3)
            const val = validateSyncEntityPayload(event.entity, event.payload);
            if (!val.success) {
              throw new PermanentSyncError('VALIDATION_ERROR', val.error);
            }
            const payloadData = val.data;

            // 3. Schema version check
            if (event.schemaVersion !== CURRENT_SCHEMA_VERSION) {
              throw new PermanentSyncError(
                'SCHEMA_VERSION_UNSUPPORTED',
                `Schema version ${event.schemaVersion} unsupported`,
              );
            }

            // 4. Table metadata check
            const tableMeta = localSchemaRegistry.get(event.entity);
            if (!tableMeta || tableMeta.tableClass === 'LOCAL') {
              throw new PermanentSyncError(
                tableMeta ? 'FORBIDDEN_TABLE_CLASS' : 'UNKNOWN_ENTITY',
                `Entity "${event.entity}" cannot be synced`,
              );
            }

            // 5. Check missing foreign references in local DB
            const refs = this.foreignRefsMap[event.entity] ?? [];
            let missingRef: { targetEntity: string; targetId: string } | null = null;
            for (const ref of refs) {
              const targetId = payloadData[ref.payloadKey] as string | undefined;
              if (!targetId) continue;
              const exists = this.sqlite
                .prepare(`SELECT 1 FROM "${ref.targetEntity}" WHERE id = ? LIMIT 1`)
                .get(targetId);
              if (!exists) {
                missingRef = { targetEntity: ref.targetEntity, targetId };
                break;
              }
            }

            if (missingRef) {
              this.sqlite.exec(`ROLLBACK TO SAVEPOINT ${spName}`);
              this.parkEvent(event, missingRef, params.nowMs);
              parkedCount++;
              continue;
            }

            // 6. Check closed shift insertion (T1)
            if (
              event.entity === 'sales' ||
              event.entity === 'returns' ||
              event.entity === 'cash_moves'
            ) {
              const shiftId = payloadData.shiftId as string | undefined;
              if (shiftId) {
                const shiftRow = this.sqlite
                  .prepare('SELECT status, closed_at_ms FROM shifts WHERE id = ? LIMIT 1')
                  .get(shiftId) as { status?: string; closed_at_ms?: number } | undefined;
                if (shiftRow && (shiftRow.status === 'closed' || shiftRow.closed_at_ms != null)) {
                  this.recordConflict(
                    event,
                    'STALE_SHIFT_SYNC_INSERT',
                    `Historical sync insert references closed shift ${shiftId}`,
                    params.nowMs,
                  );
                }
              }
            }

            const appliedBefore = appliedCount;
            // 7. Apply to table by class:
            if (tableMeta.tableClass === 'FACT') {
              const existingFact = this.sqlite
                .prepare(`SELECT * FROM "${tableMeta.tableName}" WHERE id = ? LIMIT 1`)
                .get(event.entityId) as Record<string, unknown> | undefined;

              if (existingFact) {
                const matches = this.compareFactContent(tableMeta, existingFact, payloadData);
                if (!matches) {
                  this.recordConflict(
                    event,
                    'FACT_CONTENT_HASH_MISMATCH',
                    `Fact record "${event.entityId}" already exists with different payload`,
                    params.nowMs,
                  );
                  conflictCount++;
                }
              } else {
                this.insertLocalRow(tableMeta, payloadData, event, params.nowMs);
                appliedCount++;
              }
            } else if (tableMeta.tableClass === 'ATTR') {
              const existingAttr = this.sqlite
                .prepare(`SELECT id, hlc FROM "${tableMeta.tableName}" WHERE id = ? LIMIT 1`)
                .get(event.entityId) as { id: string; hlc: string } | undefined;

              if (existingAttr) {
                if (event.hlc > existingAttr.hlc) {
                  this.updateLocalAttrRow(tableMeta, payloadData, event, params.nowMs);
                  appliedCount++;
                }
              } else {
                this.insertLocalRow(tableMeta, payloadData, event, params.nowMs);
                appliedCount++;
              }
            } else if (tableMeta.tableClass === 'MONOTONE') {
              const existingMonotone = this.sqlite
                .prepare(`SELECT * FROM "${tableMeta.tableName}" WHERE id = ? LIMIT 1`)
                .get(event.entityId) as Record<string, unknown> | undefined;

              if (existingMonotone) {
                const monotoneRule = MONOTONE_TRANSITION_RULES[tableMeta.tableName];
                if (!monotoneRule) {
                  this.recordConflict(
                    event,
                    'UNKNOWN_MONOTONE_RULE',
                    `No monotone transition rule defined for table "${tableMeta.tableName}"`,
                    params.nowMs,
                  );
                  conflictCount++;
                } else {
                  const transition = monotoneRule.checkTransition(existingMonotone, payloadData);
                  if (transition === 'rejected') {
                    throw new PermanentSyncError(
                      'INVALID_MONOTONE_TRANSITION',
                      `Monotone transition rejected for table "${tableMeta.tableName}"`,
                    );
                  }
                  if (transition === 'accepted') {
                    this.updateLocalMonotoneRow(
                      tableMeta,
                      monotoneRule,
                      payloadData,
                      event,
                      params.nowMs,
                    );
                    appliedCount++;
                  }
                }
              } else {
                this.insertLocalRow(tableMeta, payloadData, event, params.nowMs);
                appliedCount++;
              }
            }

            if (appliedCount > appliedBefore) {
              collectTouchedProjectionKeys(touch, event.entity, event.entityId, payloadData);
            }

            this.sqlite.exec(`RELEASE SAVEPOINT ${spName}`);
          } catch (err: unknown) {
            this.sqlite.exec(`ROLLBACK TO SAVEPOINT ${spName}`);
            const classified = classifySyncError(err);
            if (classified.type === 'permanent') {
              this.recordConflict(event, classified.code, classified.message, params.nowMs);
              conflictCount++;
            } else if (classified.type === 'park_foreign_key') {
              this.parkEvent(event, { targetEntity: 'unknown', targetId: 'unknown' }, params.nowMs);
              parkedCount++;
            } else {
              throw err;
            }
          }
        }

        // 8. Retry parked events FIRST: a dependency that arrived in this batch lets them apply now,
        // and their projection keys must be part of this batch's recompute (T2.6).
        this.retryParkedEvents(params.nowMs, touch);

        // 9. T2.6: recompute only the projection rows the applied events touched — the same code
        // path as the full rebuild, so the partial result equals a full rebuild. P1/S6: a projection
        // error never fails the batch (it would be retried forever and freeze the pull).
        this.recomputeProjectionsSafely(touch, params.context, params.nowMs);

        // 10. Atomically update cursors inside the same transaction
        for (const [storeId, lastPos] of Object.entries(params.nextCursors)) {
          const parsedStore = parseUuidV7(storeId);
          const cursorId = this.idGen.nextId();
          this.sqlite
            .prepare(
              `INSERT INTO local_sync_cursors (id, organization_id, store_id, last_position, created_at_ms, updated_at_ms)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(organization_id, store_id) DO UPDATE SET
                 last_position = EXCLUDED.last_position,
                 updated_at_ms = EXCLUDED.updated_at_ms`,
            )
            .run(
              cursorId,
              params.context.organizationId,
              parsedStore,
              Number(lastPos),
              params.nowMs,
              params.nowMs,
            );
        }

        // 11. T1: Reset in_sync = 0 before commit
        this.sqlite
          .prepare(
            "UPDATE local_sync_apply_state SET in_sync = 0, updated_at_ms = ? WHERE id = 'singleton'",
          )
          .run(params.nowMs);
      } catch (err) {
        throw err;
      }
    });

    executeTx();

    const formattedNextCursors: Record<string, string> = {};
    for (const [sId, p] of Object.entries(params.nextCursors)) {
      formattedNextCursors[sId] = p.toString();
    }

    return {
      appliedCount,
      skippedEchoCount,
      parkedCount,
      conflictCount,
      nextCursors: formattedNextCursors,
    };
  }

  /**
   * P1/S6: every projection key is recomputed in its own SAVEPOINT. A failure (a CHECK, a bug, a
   * constraint added later) rolls back only that key and is recorded as a `PROJECTION_FAILED`
   * conflict naming the key; the batch, its events and the cursors still commit, so the pull keeps
   * moving. Keys of open `PROJECTION_FAILED` conflicts are retried on every batch, and the conflict
   * is closed by the first successful recompute.
   */
  private recomputeProjectionsSafely(
    touch: ProjectionTouchSet,
    context: { readonly organizationId: UuidV7; readonly storeId: UuidV7 },
    nowMs: UnixMs,
  ): void {
    const open = this.sqlite
      .prepare(
        `SELECT entity, entity_id FROM local_sync_conflicts
          WHERE organization_id = ? AND reason = ? AND resolved_at_ms IS NULL`,
      )
      .all(context.organizationId, PROJECTION_FAILED) as { entity: string; entity_id: string }[];
    for (const row of open) {
      const id = parseUuidV7(row.entity_id);
      if (row.entity === STOCK_PROJECTION) touch.productIds.add(id);
      else if (row.entity === CUSTOMER_PROJECTION) touch.customerIds.add(id);
      else if (row.entity === SUPPLIER_PROJECTION) touch.supplierIds.add(id);
    }
    const nextId = () => this.idGen.nextId();
    const products = [...touch.productIds];
    const stockFor = (productIds: readonly UuidV7[]) =>
      executeStockProjectionsRebuildSync(this.sqlite, this.connection.db, {
        organizationId: context.organizationId,
        storeId: context.storeId,
        nextId,
        nowUnixMs: () => nowMs,
        productIds,
      });
    // Many products: one pass is cheaper; only when it fails do we isolate product by product.
    const together =
      products.length > 1 && this.tryProjection('sp_proj_stock_all', () => stockFor(products));
    for (const productId of products) {
      this.runProjectionKey(STOCK_PROJECTION, productId, context, nowMs, () =>
        together ? undefined : stockFor([productId]),
      );
    }
    for (const customerId of touch.customerIds) {
      this.runProjectionKey(CUSTOMER_PROJECTION, customerId, context, nowMs, () => {
        recomputeCustomerBalancesForIdsSync(this.sqlite, this.connection.db, {
          organizationId: context.organizationId,
          customerIds: [customerId],
          nowMs,
          nextId,
        });
        this.noteCustomerOverpaid(customerId, context, nowMs);
      });
    }
    for (const supplierId of touch.supplierIds) {
      this.runProjectionKey(SUPPLIER_PROJECTION, supplierId, context, nowMs, () =>
        recomputeSupplierBalancesForIdsSync(this.sqlite, this.connection.db, {
          organizationId: context.organizationId,
          supplierIds: [supplierId],
          nowMs,
          nextId,
        }),
      );
    }
  }

  private tryProjection(savepoint: string, run: () => unknown): boolean {
    this.sqlite.exec(`SAVEPOINT ${savepoint}`);
    try {
      run();
      this.sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return true;
    } catch {
      this.sqlite.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      this.sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return false;
    }
  }

  private runProjectionKey(
    projection: string,
    key: UuidV7,
    context: { readonly organizationId: UuidV7; readonly storeId: UuidV7 },
    nowMs: UnixMs,
    run: () => unknown,
  ): void {
    this.sqlite.exec('SAVEPOINT sp_proj_key');
    let error: string | null = null;
    try {
      run();
      this.sqlite.exec('RELEASE SAVEPOINT sp_proj_key');
    } catch (err) {
      this.sqlite.exec('ROLLBACK TO SAVEPOINT sp_proj_key');
      this.sqlite.exec('RELEASE SAVEPOINT sp_proj_key');
      error = err instanceof Error ? err.message : String(err);
    }
    if (error === null) {
      this.resolveOpenConflict(PROJECTION_FAILED, projection, key, nowMs);
    } else {
      this.upsertOpenConflict(PROJECTION_FAILED, projection, key, context, nowMs, error, {
        projection,
        key,
      });
    }
  }

  /** S6: a negative customer balance is a real overpayment, visible as a view-only conflict. */
  private noteCustomerOverpaid(
    customerId: UuidV7,
    context: { readonly organizationId: UuidV7; readonly storeId: UuidV7 },
    nowMs: UnixMs,
  ): void {
    const row = this.sqlite
      .prepare('SELECT balance FROM local_customer_balances WHERE customer_id = ?')
      .get(customerId) as { balance: number | bigint } | undefined;
    const balance = row === undefined ? 0n : BigInt(row.balance);
    if (balance < 0n) {
      this.upsertOpenConflict(
        CUSTOMER_OVERPAID,
        'customers',
        customerId,
        context,
        nowMs,
        `Customer overpaid by ${(-balance).toString()} tiyin (the customer's credit)`,
        { overpaidTiyin: (-balance).toString() },
      );
    } else {
      this.resolveOpenConflict(CUSTOMER_OVERPAID, 'customers', customerId, nowMs);
    }
  }

  private upsertOpenConflict(
    reason: string,
    entity: string,
    entityId: UuidV7,
    context: { readonly organizationId: UuidV7; readonly storeId: UuidV7 },
    nowMs: UnixMs,
    error: string,
    payload: Record<string, string>,
  ): void {
    const open = this.sqlite
      .prepare(
        `SELECT id FROM local_sync_conflicts
          WHERE organization_id = ? AND reason = ? AND entity = ? AND entity_id = ?
            AND resolved_at_ms IS NULL LIMIT 1`,
      )
      .get(context.organizationId, reason, entity, entityId) as { id: string } | undefined;
    if (open) {
      this.sqlite
        .prepare(
          'UPDATE local_sync_conflicts SET error = ?, payload = ?, updated_at_ms = ? WHERE id = ?',
        )
        .run(error, JSON.stringify(payload), nowMs, open.id);
      return;
    }
    const id = this.idGen.nextId();
    this.sqlite
      .prepare(
        `INSERT INTO local_sync_conflicts (
           id, organization_id, store_id, event_id, entity, entity_id,
           reason, error, payload, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        context.organizationId,
        context.storeId,
        id,
        entity,
        entityId,
        reason,
        error,
        JSON.stringify(payload),
        nowMs,
        nowMs,
      );
  }

  private resolveOpenConflict(reason: string, entity: string, entityId: UuidV7, nowMs: UnixMs) {
    this.sqlite
      .prepare(
        `UPDATE local_sync_conflicts SET resolved_at_ms = ?, updated_at_ms = ?
          WHERE reason = ? AND entity = ? AND entity_id = ? AND resolved_at_ms IS NULL`,
      )
      .run(nowMs, nowMs, reason, entity, entityId);
  }

  private clampLocalRowHlc(event: SyncedEventDto, nowMs: UnixMs): void {
    const tableMeta = localSchemaRegistry.get(event.entity);
    if (!tableMeta || tableMeta.tableClass === 'LOCAL') return;
    try {
      this.sqlite
        .prepare(
          `UPDATE "${tableMeta.tableName}" SET hlc = ?, updated_at_ms = ? WHERE id = ? AND hlc > ?`,
        )
        .run(event.hlc, nowMs, event.entityId, event.hlc);
    } catch {
      // Ignore
    }
  }

  private parkEvent(
    event: SyncedEventDto,
    missingRef: { targetEntity: string; targetId: string },
    nowMs: UnixMs,
  ): void {
    const payloadStr =
      typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload);
    this.sqlite
      .prepare(
        `INSERT INTO local_sync_parked (
           id, organization_id, store_id, event_id, entity, entity_id,
           missing_ref_entity, missing_ref_id, attempts, payload, last_error,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(organization_id, event_id) DO UPDATE SET
           attempts = local_sync_parked.attempts + 1,
           updated_at_ms = EXCLUDED.updated_at_ms`,
      )
      .run(
        event.eventId,
        event.organizationId,
        event.storeId,
        event.eventId,
        event.entity,
        event.entityId,
        missingRef.targetEntity,
        missingRef.targetId,
        payloadStr,
        `Missing referenced entity "${missingRef.targetEntity}" (${missingRef.targetId})`,
        nowMs,
        nowMs,
      );
  }

  private recordConflict(
    event: SyncedEventDto,
    reason: string,
    errorMsg: string,
    nowMs: UnixMs,
  ): void {
    const payloadStr =
      typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload);
    this.sqlite
      .prepare(
        `INSERT INTO local_sync_conflicts (
           id, organization_id, store_id, event_id, entity, entity_id,
           reason, error, payload, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           error = EXCLUDED.error,
           updated_at_ms = EXCLUDED.updated_at_ms`,
      )
      .run(
        event.eventId,
        event.organizationId,
        event.storeId,
        event.eventId,
        event.entity,
        event.entityId,
        reason,
        errorMsg,
        payloadStr,
        nowMs,
        nowMs,
      );
  }

  private compareFactContent(
    tableMeta: SqliteTableMetadata,
    existing: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): boolean {
    const cols = getTableColumns(tableMeta.table);
    for (const [propKey, colObj] of Object.entries(cols)) {
      const col = colObj as { name: string };
      if (
        col.name === 'id' ||
        col.name === 'organization_id' ||
        col.name === 'store_id' ||
        col.name === 'device_id' ||
        col.name === 'hlc' ||
        col.name === 'created_at_ms' ||
        col.name === 'updated_at_ms'
      ) {
        continue;
      }
      const existingVal = existing[col.name];
      const payloadVal = payload[propKey];
      if (payloadVal !== undefined && payloadVal !== null) {
        if (toComparableString(payloadVal) !== toComparableString(existingVal)) {
          return false;
        }
      }
    }
    return true;
  }

  private insertLocalRow(
    tableMeta: SqliteTableMetadata,
    payloadData: Record<string, unknown>,
    event: SyncedEventDto,
    nowMs: UnixMs,
  ): void {
    const cols = getTableColumns(tableMeta.table);
    const colNames: string[] = ['id', 'organization_id', 'created_at_ms'];
    const colValues: unknown[] = [
      event.entityId,
      event.organizationId,
      payloadData.createdAtMs ?? nowMs,
    ];
    const placeholders: string[] = ['?', '?', '?'];

    if (tableMeta.tenantScope === 'store') {
      colNames.push('store_id');
      colValues.push(event.storeId);
      placeholders.push('?');
    }

    if (tableMeta.tableClass !== 'LOCAL') {
      colNames.push('device_id', 'hlc');
      colValues.push(event.deviceId, event.hlc);
      placeholders.push('?', '?');
    }

    if (tableMeta.tableClass === 'ATTR' || tableMeta.tableClass === 'MONOTONE') {
      colNames.push('updated_at_ms');
      colValues.push(payloadData.updatedAtMs ?? nowMs);
      placeholders.push('?');
    }

    if (tableMeta.tableClass === 'ATTR') {
      colNames.push('deleted_at_ms');
      colValues.push(payloadData.deletedAtMs ?? null);
      placeholders.push('?');
    }

    for (const [propKey, colObj] of Object.entries(cols)) {
      const col = colObj as { name: string };
      if (colNames.includes(col.name)) continue;
      const val = payloadData[propKey];
      colNames.push(col.name);
      placeholders.push('?');
      if (typeof val === 'boolean') {
        colValues.push(val ? 1 : 0);
      } else if (val !== undefined) {
        colValues.push(val);
      } else {
        colValues.push(null);
      }
    }

    const sqlStr = `INSERT INTO "${tableMeta.tableName}" (${colNames.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders.join(', ')})`;
    this.sqlite.prepare(sqlStr).run(...colValues);
  }

  private updateLocalAttrRow(
    tableMeta: SqliteTableMetadata,
    payloadData: Record<string, unknown>,
    event: SyncedEventDto,
    nowMs: UnixMs,
  ): void {
    const cols = getTableColumns(tableMeta.table);
    const setClauses: string[] = ['"hlc" = ?', '"updated_at_ms" = ?'];
    const values: unknown[] = [event.hlc, payloadData.updatedAtMs ?? nowMs];

    if (event.type.endsWith('.restored') || payloadData.deletedAtMs === null) {
      setClauses.push('"deleted_at_ms" = NULL');
    } else if (payloadData.deletedAtMs !== undefined) {
      setClauses.push('"deleted_at_ms" = ?');
      values.push(payloadData.deletedAtMs);
    }

    for (const [propKey, colObj] of Object.entries(cols)) {
      const col = colObj as { name: string };
      if (
        col.name === 'id' ||
        col.name === 'organization_id' ||
        col.name === 'store_id' ||
        col.name === 'device_id' ||
        col.name === 'hlc' ||
        col.name === 'created_at_ms' ||
        col.name === 'updated_at_ms' ||
        col.name === 'deleted_at_ms'
      ) {
        continue;
      }
      const val = payloadData[propKey];
      setClauses.push(`"${col.name}" = ?`);
      if (typeof val === 'boolean') {
        values.push(val ? 1 : 0);
      } else if (val !== undefined) {
        values.push(val);
      } else {
        values.push(null);
      }
    }

    values.push(event.entityId);
    const sqlStr = `UPDATE "${tableMeta.tableName}" SET ${setClauses.join(', ')} WHERE id = ?`;
    this.sqlite.prepare(sqlStr).run(...values);
  }

  private updateLocalMonotoneRow(
    tableMeta: SqliteTableMetadata,
    rule: MonotoneTransitionRule,
    payloadData: Record<string, unknown>,
    event: SyncedEventDto,
    nowMs: UnixMs,
  ): void {
    const cols = getTableColumns(tableMeta.table);
    const setClauses: string[] = ['"hlc" = ?', '"updated_at_ms" = ?'];
    const values: unknown[] = [event.hlc, payloadData.updatedAtMs ?? nowMs];

    const allowableSet = new Set<string>(rule.allowableUpdateColumns ?? []);

    for (const [propKey, colObj] of Object.entries(cols)) {
      const col = colObj as { name: string };
      if (allowableSet.has(propKey) || allowableSet.has(col.name)) {
        const val = payloadData[propKey];
        setClauses.push(`"${col.name}" = ?`);
        if (typeof val === 'boolean') {
          values.push(val ? 1 : 0);
        } else if (val !== undefined) {
          values.push(val);
        } else {
          values.push(null);
        }
      }
    }

    values.push(event.entityId);
    const sqlStr = `UPDATE "${tableMeta.tableName}" SET ${setClauses.join(', ')} WHERE id = ?`;
    this.sqlite.prepare(sqlStr).run(...values);
  }

  private retryParkedEvents(nowMs: UnixMs, touch: ProjectionTouchSet): void {
    const parked = this.sqlite
      .prepare('SELECT * FROM local_sync_parked ORDER BY attempts ASC, created_at_ms ASC LIMIT 50')
      .all() as Array<{
      id: string;
      organization_id: string;
      store_id: string;
      event_id: string;
      entity: string;
      entity_id: string;
      missing_ref_entity: string;
      missing_ref_id: string;
      attempts: number;
      payload: string;
    }>;

    for (const row of parked) {
      const exists = this.sqlite
        .prepare(`SELECT 1 FROM "${row.missing_ref_entity}" WHERE id = ? LIMIT 1`)
        .get(row.missing_ref_id);

      if (exists) {
        let payloadObj: Record<string, unknown> = {};
        try {
          payloadObj = JSON.parse(row.payload) as Record<string, unknown>;
        } catch {
          payloadObj = {};
        }

        const tableMeta = localSchemaRegistry.get(row.entity);
        if (tableMeta) {
          const pseudoDeviceId = parseUuidV7(
            (payloadObj.deviceId ?? payloadObj.device_id ?? row.store_id) as string,
          );
          const pseudoHlc =
            (payloadObj.hlc as string) ??
            '000170000000000:00000:01880000-0000-7000-8000-000000000001';
          const pseudoEvent: SyncedEventDto = {
            eventId: parseUuidV7(row.event_id),
            organizationId: parseUuidV7(row.organization_id),
            storeId: parseUuidV7(row.store_id),
            deviceId: pseudoDeviceId,
            deviceSeq: '1',
            hlc: pseudoHlc,
            type: `${row.entity}.created`,
            entity: row.entity,
            entityId: parseUuidV7(row.entity_id),
            entityClass: tableMeta.tableClass as 'FACT' | 'ATTR' | 'MONOTONE',
            schemaVersion: CURRENT_SCHEMA_VERSION,
            payload: payloadObj,
            position: '1',
            hlcAdjusted: false,
            receivedAtMs: nowMs,
          };

          this.insertLocalRow(tableMeta, payloadObj, pseudoEvent, nowMs);
          collectTouchedProjectionKeys(touch, row.entity, row.entity_id, payloadObj);
        }

        this.sqlite.prepare('DELETE FROM local_sync_parked WHERE id = ?').run(row.id);
      } else {
        const nextAttempts = Number(row.attempts) + 1;
        if (nextAttempts >= 20) {
          this.sqlite.prepare('DELETE FROM local_sync_parked WHERE id = ?').run(row.id);

          this.sqlite
            .prepare(
              `INSERT INTO local_sync_conflicts (
                 id, organization_id, store_id, event_id, entity, entity_id,
                 reason, error, payload, created_at_ms, updated_at_ms
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 error = EXCLUDED.error,
                 updated_at_ms = EXCLUDED.updated_at_ms`,
            )
            .run(
              row.event_id,
              row.organization_id,
              row.store_id,
              row.event_id,
              row.entity,
              row.entity_id,
              'DEPENDENCY_UNRESOLVED',
              `Missing referenced entity "${row.missing_ref_entity}" (${row.missing_ref_id}) unresolved after 20 attempts`,
              row.payload,
              nowMs,
              nowMs,
            );
        } else {
          this.sqlite
            .prepare('UPDATE local_sync_parked SET attempts = ?, updated_at_ms = ? WHERE id = ?')
            .run(nextAttempts, nowMs, row.id);
        }
      }
    }
  }
}
