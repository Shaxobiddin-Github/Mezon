import {
  type FiscalDocDto,
  type FiscalOfflineWarning,
  FiscalReceiptFieldsConfigSchema,
  type FiscalReceiptFieldsConfig,
  type FiscalStatusResponse,
} from '@mezon/contracts';
import type {
  FiscalDocListItem,
  LocalSqliteConnection,
  SqliteFiscalStore,
  StoredFiscalDocRecord,
} from '@mezon/db-local';
import {
  DomainError,
  type ReceiptFiscalBlock,
  type UuidV7,
  resolveReceiptFiscalBlock,
} from '@mezon/domain';
import type { FiscalDriver } from '@mezon/drivers';
import type { Logger } from 'pino';
import type { HubFiscalWorker } from './fiscal-worker.js';
import type { HubRulesService } from './rules-service.js';

export function toFiscalDocDto(
  doc: StoredFiscalDocRecord,
  receiptCode: string | null = null,
): FiscalDocDto {
  return {
    id: doc.id,
    docKind: doc.docKind,
    saleId: doc.saleId,
    returnId: doc.returnId,
    shiftId: doc.shiftId,
    dependsOnDocId: doc.dependsOnDocId,
    receiptCode,
    status: doc.status,
    attempts: doc.attempts,
    lastErrorCode: doc.lastErrorCode,
    lastErrorMessage: doc.lastErrorMessage,
    sentAtMs: doc.sentAtMs === null ? null : doc.sentAtMs.toString(),
    confirmedAtMs: doc.confirmedAtMs === null ? null : doc.confirmedAtMs.toString(),
    fiscalSign: doc.fiscalSign,
    fiscalNumber: doc.fiscalNumber,
    driverId: doc.driverId,
    offlineDeadlineMs: doc.offlineDeadlineMs.toString(),
    createdAtMs: doc.createdAtMs.toString(),
  };
}

/**
 * Offline warning (controller fix #2): computed from the OLDEST unsettled document.
 * `approaching` from 75 % of the window, `expired` at/after the deadline.
 */
export function resolveOfflineWarning(
  oldestDeadlineMs: bigint | null,
  windowMs: bigint,
  nowMs: bigint,
): FiscalOfflineWarning {
  if (oldestDeadlineMs === null) return 'none';
  if (nowMs >= oldestDeadlineMs) return 'expired';
  if (nowMs >= oldestDeadlineMs - windowMs / 4n) return 'approaching';
  return 'none';
}

export function parseReceiptFieldsConfig(json: string): FiscalReceiptFieldsConfig | null {
  try {
    const parsed = FiscalReceiptFieldsConfigSchema.safeParse(JSON.parse(json) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface HubFiscalServiceOptions {
  readonly store: SqliteFiscalStore;
  readonly connection: LocalSqliteConnection;
  readonly driver: FiscalDriver;
  readonly worker: HubFiscalWorker;
  readonly rulesService: HubRulesService;
  readonly nowMs: () => bigint;
  readonly getOrganizationId: () => UuidV7 | null;
  readonly logger?: Logger;
}

export class HubFiscalService {
  private readonly o: HubFiscalServiceOptions;

  constructor(options: HubFiscalServiceOptions) {
    this.o = options;
  }

  get driver(): FiscalDriver {
    return this.o.driver;
  }

  status(): FiscalStatusResponse {
    const s = this.o.store.summarySync();
    const cfg = this.o.store.readConfigSync();
    return {
      modeEnabled: s.modeEnabled,
      driverId: s.driverId,
      isTestDriver: this.o.driver.isTestDriver,
      counts: s.counts,
      oldestDeadlineMs: s.oldestDeadlineMs === null ? null : s.oldestDeadlineMs.toString(),
      offlineWindowMs: s.offlineWindowMs.toString(),
      offlineWarning: resolveOfflineWarning(
        s.oldestDeadlineMs === null ? null : BigInt(s.oldestDeadlineMs),
        s.offlineWindowMs,
        this.o.nowMs(),
      ),
      blockOnOfflineExpired: s.blockOnOfflineExpired,
      requireOpenShift: s.requireOpenShift,
      receiptFieldsValid: parseReceiptFieldsConfig(cfg.receiptFieldsJson) !== null,
    };
  }

  listUnsettled(): FiscalDocDto[] {
    return this.o.store
      .listUnsettled()
      .map((d: FiscalDocListItem) => toFiscalDocDto(d, d.receiptCode));
  }

  saleDoc(saleId: UuidV7): StoredFiscalDocRecord | null {
    return this.o.store.getSaleDocSync(saleId);
  }

  /** T3.4 receipt block for a sale or return; `undefined` when no fiscal document exists. */
  receiptBlock(ref: {
    readonly saleId?: UuidV7;
    readonly returnId?: UuidV7;
  }): ReceiptFiscalBlock | undefined {
    const doc =
      ref.returnId !== undefined
        ? this.o.store.getReturnDocSync(ref.returnId)
        : ref.saleId !== undefined
          ? this.o.store.getSaleDocSync(ref.saleId)
          : null;
    if (doc === null) return undefined;
    const orgId = this.o.getOrganizationId();
    const tin = orgId
      ? ((
          this.o.connection.sqlite
            .prepare(
              'SELECT tin FROM organization_tax_profiles WHERE organization_id = ? AND deleted_at_ms IS NULL',
            )
            .get(orgId) as { tin: string } | undefined
        )?.tin ?? null)
      : null;
    return resolveReceiptFiscalBlock({
      status: doc.status,
      values: {
        fiscalSign: doc.fiscalSign,
        fiscalNumber: doc.fiscalNumber,
        confirmedAt:
          doc.confirmedAtMs === null ? null : new Date(Number(doc.confirmedAtMs)).toISOString(),
        driverId: doc.driverId,
        organizationTin: tin,
      },
      qrPayload: doc.qrPayload,
      fields: this.receiptFields(),
      isTestDriver: this.o.driver.isTestDriver,
    });
  }

  receiptFields(): FiscalReceiptFieldsConfig {
    return parseReceiptFieldsConfig(this.o.store.readConfigSync().receiptFieldsJson) ?? [];
  }

  /** Manager retry: only re-queues; the worker (single path) is nudged, never the driver directly. */
  async retry(id: UuidV7): Promise<StoredFiscalDocRecord> {
    const doc = await this.o.store.requeueFailed(id);
    this.o.worker.kick();
    return doc;
  }

  /**
   * Owner-only fiscal mode switch. Enabling requires: a verified rules package in state `ok`, a
   * responding driver, zero active products without MXIK and a valid non-empty receipt field
   * configuration. Every change is audit-logged with the acting user.
   */
  async setMode(enabled: boolean, actorUserId: UuidV7): Promise<boolean> {
    if (enabled) {
      const failures: string[] = [];
      if (this.o.rulesService.loadStatusSync(this.o.nowMs()).state !== 'ok') {
        failures.push('RULES_PACKAGE_NOT_OK');
      }
      try {
        await this.o.driver.ping();
      } catch {
        failures.push('DRIVER_UNREACHABLE');
      }
      const orgId = this.o.getOrganizationId();
      const missing = orgId
        ? (
            this.o.connection.sqlite
              .prepare(
                'SELECT count(*) AS n FROM products WHERE organization_id = ? AND deleted_at_ms IS NULL AND mxik IS NULL',
              )
              .get(orgId) as { n: bigint }
          ).n
        : 0n;
      if (missing > 0n) failures.push('PRODUCTS_WITHOUT_MXIK');
      const fields = this.receiptFields();
      if (fields.length === 0) failures.push('RECEIPT_FIELDS_NOT_CONFIGURED');
      if (failures.length > 0) {
        throw new DomainError(
          'FISCAL_MODE_PRECONDITION_FAILED',
          `Fiscal mode cannot be enabled: ${failures.join(', ')}`,
          { details: { failures, productsWithoutMxik: missing.toString() } },
        );
      }
    }
    await this.o.store.setModeEnabled(enabled);
    this.o.logger?.info(
      { event: 'fiscal.mode_changed', enabled, actorUserId },
      'Fiscal mode changed',
    );
    return enabled;
  }
}
