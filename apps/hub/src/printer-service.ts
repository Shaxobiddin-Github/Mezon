import type {
  CashDrawerEventDto,
  ListReceiptPrintsResponseDto,
  ListWindowsPrintersResponseDto,
  OpenCashDrawerRequestDto,
  OpenCashDrawerResponseDto,
  PrintDocumentRequestDto,
  PrintDocumentResponseDto,
  PrinterSettingsDto,
  PrinterSettingsResponseDto,
  ReceiptPrintRecordDto,
  TestPrintResponseDto,
  UpdatePrinterSettingsRequestDto,
} from '@mezon/contracts';
import {
  type AuthenticatedSessionSnapshot,
  type ReceiptPrintDocumentType,
  type SqlitePrinterStore,
  type SqliteReturnStore,
  type SqliteSaleStore,
  type SqliteShiftStore,
  type StoredCashDrawerEventRow,
  type StoredPrinterSettings,
  type StoredReceiptPrintRow,
} from '@mezon/db-local';
import {
  DomainError,
  type UnixMs,
  type ReceiptFiscalBlock,
  type UuidV7,
  moneyToTiyin,
  parseUuidV7,
  quantityToMilli,
  roleHasPermission,
  unixMsToBigInt,
} from '@mezon/domain';
import {
  NullPrinterDriver,
  type DiscoveredWindowsPrinter,
  type PrintOutcomeStatus,
  type PrintableDocument,
  type PrinterConfig,
  type PrinterDriver,
  type ReturnReceiptDocument,
  type SaleReceiptDocument,
  type ShiftCloseReportDocument,
  type TestPrintDocument,
  assertValidLocalPrinterHost,
  encodeCashDrawerPulse,
  encodeEscPosDocument,
} from '@mezon/drivers';
import {
  NetworkPrinterDriver,
  WindowsRawPrinterDriver,
  listInstalledWindowsPrinters,
} from '@mezon/drivers/node';
import type { HubAuthService } from './auth-service.js';

export interface HubPrinterServiceOptions {
  readonly printerStore: SqlitePrinterStore;
  readonly authService: HubAuthService;
  readonly saleStore: SqliteSaleStore;
  readonly returnStore: SqliteReturnStore;
  readonly shiftStore: SqliteShiftStore;
  /** Test seam: inject a driver (e.g. `FakePrinterDriver`). Never passed by Hub/Electron runtime. */
  readonly printerDriverFactory?: (config: PrinterConfig) => PrinterDriver;
  readonly listWindowsPrintersFn?: () => Promise<readonly DiscoveredWindowsPrinter[]>;
  /**
   * T4.3 the printer of a LAN register. A register prints ONLY to its own printer: when it has
   * none (null), its jobs are recorded as `disabled` instead of going to the hub's printer.
   */
  readonly resolveTerminalPrinter?: (terminalId: UuidV7) => TerminalPrinterDevice | null;
  readonly nowMs?: () => bigint;
  /** T3.4: fiscal block for a receipt (undefined → legacy non-fiscal receipt). */
  readonly resolveFiscalBlock?: (ref: {
    readonly saleId?: UuidV7;
    readonly returnId?: UuidV7;
  }) => ReceiptFiscalBlock | undefined;
}

export interface TerminalPrinterDevice {
  readonly mode: PrinterConfig['mode'];
  readonly printerName: string | null;
  readonly host: string | null;
  readonly port: number;
  readonly timeoutMs: number;
  readonly paperWidthMm: PrinterConfig['paperWidthMm'];
  readonly encoding: PrinterConfig['encoding'];
  readonly cashDrawerAutoOpen: boolean;
}

interface SendOutcome {
  readonly status: PrintOutcomeStatus;
  readonly printerTarget: string | null;
  readonly bytesSent: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export function formatUnixMsInTimezone(unixMs: UnixMs | bigint, timeZone: string): string {
  const date = new Date(Number(unixMs));
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 19).replace('T', ' ');
  }
}

function toPrinterConfig(s: StoredPrinterSettings): PrinterConfig {
  return {
    mode: s.mode,
    printerName: s.printerName,
    host: s.host,
    port: s.port,
    timeoutMs: s.timeoutMs,
    paperWidthMm: s.paperWidthMm,
    encoding: s.encoding,
    autoPrintSale: s.autoPrintSale,
    cashDrawerAutoOpen: s.cashDrawerAutoOpen,
    receiptHeaderTitle: s.receiptHeaderTitle,
    receiptFooterText: s.receiptFooterText,
  };
}

function toSettingsDto(c: PrinterConfig): PrinterSettingsDto {
  return {
    mode: c.mode,
    printerName: c.printerName,
    host: c.host,
    port: c.port,
    timeoutMs: c.timeoutMs,
    paperWidthMm: c.paperWidthMm,
    encoding: c.encoding,
    autoPrintSale: c.autoPrintSale,
    cashDrawerAutoOpen: c.cashDrawerAutoOpen,
    receiptHeaderTitle: c.receiptHeaderTitle,
    receiptFooterText: c.receiptFooterText,
  };
}

function toReceiptPrintDto(r: StoredReceiptPrintRow): ReceiptPrintRecordDto {
  return {
    id: r.id,
    organizationId: r.organizationId,
    storeId: r.storeId,
    documentType: r.documentType as ReceiptPrintRecordDto['documentType'],
    documentId: r.documentId,
    printSeq: r.printSeq,
    copyNumber: r.copyNumber,
    isReprint: Boolean(r.isReprint),
    actorUserId: r.actorUserId,
    status: r.status as ReceiptPrintRecordDto['status'],
    printerMode: r.printerMode as ReceiptPrintRecordDto['printerMode'],
    printerTarget: r.printerTarget,
    bytesSent: r.bytesSent,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    textPreview: r.textPreview,
    clientRequestId: r.clientRequestId,
    createdAtMs: r.createdAtMs.toString(),
  };
}

function toCashDrawerDto(r: StoredCashDrawerEventRow): CashDrawerEventDto {
  return {
    id: r.id,
    organizationId: r.organizationId,
    storeId: r.storeId,
    shiftId: r.shiftId,
    actorUserId: r.actorUserId,
    overrideApprovedByUserId: r.overrideApprovedByUserId,
    reason: r.reason,
    status: r.status as CashDrawerEventDto['status'],
    printerMode: r.printerMode as CashDrawerEventDto['printerMode'],
    printerTarget: r.printerTarget,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    clientRequestId: r.clientRequestId,
    createdAtMs: r.createdAtMs.toString(),
  };
}

/**
 * T1.12 printing orchestration. Persistence lives in `SqlitePrinterStore`; this service builds
 * receipt documents, encodes ESC/POS and talks to the configured driver.
 *
 * Guarantees:
 * - A printer failure never rolls back or blocks the sale/return/shift close (they are committed first).
 * - P1: a `clientRequestId` prints at most once — DB replay check plus an in-process in-flight map,
 *   so double clicks and retries never send bytes twice.
 * - Reprints are marked "NUSXA #N"; `copyNumber` counts earlier non-failed prints.
 */
export class HubPrinterService {
  private readonly printerStore: SqlitePrinterStore;
  private readonly authService: HubAuthService;
  private readonly saleStore: SqliteSaleStore;
  private readonly returnStore: SqliteReturnStore;
  private readonly shiftStore: SqliteShiftStore;
  private readonly driverFactory: ((config: PrinterConfig) => PrinterDriver) | undefined;
  private readonly listWindowsPrintersFn: () => Promise<readonly DiscoveredWindowsPrinter[]>;
  private readonly nowMs: () => bigint;
  private readonly resolveFiscalBlock: NonNullable<HubPrinterServiceOptions['resolveFiscalBlock']>;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly resolveTerminalPrinter: (terminalId: UuidV7) => TerminalPrinterDevice | null;

  constructor(options: HubPrinterServiceOptions) {
    this.printerStore = options.printerStore;
    this.authService = options.authService;
    this.saleStore = options.saleStore;
    this.returnStore = options.returnStore;
    this.shiftStore = options.shiftStore;
    this.driverFactory = options.printerDriverFactory;
    this.listWindowsPrintersFn = options.listWindowsPrintersFn ?? listInstalledWindowsPrinters;
    this.nowMs = options.nowMs ?? (() => BigInt(Date.now()));
    this.resolveFiscalBlock = options.resolveFiscalBlock ?? (() => undefined);
    this.resolveTerminalPrinter = options.resolveTerminalPrinter ?? (() => null);
  }

  /** Hub settings, with the device part replaced by the register's own printer (T4.3). */
  private configFor(base: PrinterConfig, terminalId: UuidV7 | null): PrinterConfig {
    if (terminalId === null) return base;
    const device = this.resolveTerminalPrinter(terminalId);
    if (device === null) return { ...base, mode: 'disabled', cashDrawerAutoOpen: false };
    return { ...base, ...device };
  }

  private createDriver(config: PrinterConfig): PrinterDriver {
    if (this.driverFactory) {
      return this.driverFactory(config);
    }
    switch (config.mode) {
      case 'disabled':
        return new NullPrinterDriver();
      case 'windows_raw':
        return new WindowsRawPrinterDriver({ printerName: config.printerName ?? '' });
      case 'network_tcp':
        return new NetworkPrinterDriver({
          host: config.host ?? '',
          port: config.port,
          timeoutMs: config.timeoutMs,
        });
    }
  }

  private async send(
    config: PrinterConfig,
    bytes: Uint8Array,
    jobTitle: string,
  ): Promise<SendOutcome> {
    if (config.mode === 'disabled') {
      return {
        status: 'disabled',
        printerTarget: null,
        bytesSent: 0,
        errorCode: null,
        errorMessage: null,
      };
    }
    try {
      const res = await this.createDriver(config).sendRaw(bytes, jobTitle);
      if (res.ok) {
        return {
          status: res.mode === 'disabled' ? 'disabled' : 'printed',
          printerTarget: res.target,
          bytesSent: res.bytesSent,
          errorCode: null,
          errorMessage: null,
        };
      }
      return {
        status: 'failed',
        printerTarget: res.target,
        bytesSent: 0,
        errorCode: res.errorCode,
        errorMessage: res.errorMessage,
      };
    } catch (err) {
      return {
        status: 'failed',
        printerTarget: null,
        bytesSent: 0,
        errorCode: 'PRINTER_DRIVER_ERROR',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Serializes work per idempotency key inside this Hub process (P1). */
  private async once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key);
    if (pending) {
      await pending.catch(() => undefined);
      return work();
    }
    const p = work();
    this.inFlight.set(key, p);
    try {
      return await p;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async getSettings(): Promise<PrinterSettingsResponseDto> {
    const s = await this.printerStore.getPrinterSettings();
    return { settings: toSettingsDto(toPrinterConfig(s)) };
  }

  async updateSettings(body: UpdatePrinterSettingsRequestDto): Promise<PrinterSettingsResponseDto> {
    const current = toPrinterConfig(await this.printerStore.getPrinterSettings());
    const host =
      body.host === undefined
        ? current.host
        : body.host === null
          ? null
          : assertValidLocalPrinterHost(body.host);
    const next: PrinterConfig = {
      mode: body.mode ?? current.mode,
      printerName: body.printerName !== undefined ? body.printerName : current.printerName,
      host,
      port: body.port ?? current.port,
      timeoutMs: body.timeoutMs ?? current.timeoutMs,
      paperWidthMm: body.paperWidthMm ?? current.paperWidthMm,
      encoding: body.encoding ?? current.encoding,
      autoPrintSale: body.autoPrintSale ?? current.autoPrintSale,
      cashDrawerAutoOpen: body.cashDrawerAutoOpen ?? current.cashDrawerAutoOpen,
      receiptHeaderTitle: body.receiptHeaderTitle ?? current.receiptHeaderTitle,
      receiptFooterText: body.receiptFooterText ?? current.receiptFooterText,
    };
    if (
      next.mode === 'windows_raw' &&
      (next.printerName === null || next.printerName.trim() === '')
    ) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'Windows RAW rejimi uchun printer nomi kiritilishi shart',
      );
    }
    if (next.mode === 'network_tcp' && next.host === null) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'Tarmoq rejimi uchun lokal IPv4 manzil kiritilishi shart',
      );
    }
    const saved = await this.printerStore.updatePrinterSettings(next);
    return { settings: toSettingsDto(toPrinterConfig(saved)) };
  }

  async listWindowsPrinters(): Promise<ListWindowsPrintersResponseDto> {
    const list = await this.listWindowsPrintersFn();
    return { printers: list.map((p) => ({ name: p.name, isDefault: p.isDefault })) };
  }

  async testPrint(terminalId: UuidV7 | null = null): Promise<TestPrintResponseDto> {
    const settings = await this.printerStore.getPrinterSettings();
    const config = this.configFor(toPrinterConfig(settings), terminalId);
    const target =
      config.mode === 'windows_raw'
        ? (config.printerName ?? '-')
        : config.mode === 'network_tcp'
          ? `${config.host ?? '-'}:${String(config.port)}`
          : 'Printersiz rejim';
    const doc: TestPrintDocument = {
      kind: 'test',
      headerTitle: config.receiptHeaderTitle,
      footerText: config.receiptFooterText,
      printerMode: config.mode,
      target,
      paperWidthMm: config.paperWidthMm,
      encoding: config.encoding,
      formattedDateTime: formatUnixMsInTimezone(this.nowMs(), settings.storeTimezone),
    };
    const encoded = encodeEscPosDocument({
      document: doc,
      paperWidthMm: config.paperWidthMm,
      encoding: config.encoding,
    });
    const out = await this.send(config, encoded.bytes, 'Guzar test cheki');
    return {
      status: out.status,
      printerMode: config.mode,
      printerTarget: out.printerTarget,
      bytesSent: out.bytesSent,
      errorCode: out.errorCode,
      errorMessage: out.errorMessage,
      textPreview: encoded.textPreview,
    };
  }

  async openCashDrawer(
    session: AuthenticatedSessionSnapshot,
    body: OpenCashDrawerRequestDto,
    terminalId: UuidV7 | null = null,
  ): Promise<{
    readonly response: OpenCashDrawerResponseDto;
    readonly overrideApprovedByUserId: UuidV7 | null;
  }> {
    const clientRequestId = parseUuidV7(body.clientRequestId);
    return this.once(`drawer:${clientRequestId}`, async () => {
      const existing = await this.printerStore.findCashDrawerEventByRequest(clientRequestId);
      if (existing) {
        return {
          response: { event: toCashDrawerDto(existing), idempotentReplay: true },
          overrideApprovedByUserId: existing.overrideApprovedByUserId,
        };
      }
      let overrideApprovedByUserId: UuidV7 | null = null;
      if (!roleHasPermission(session.user.role, 'printer:cash_drawer')) {
        if (!body.override) {
          throw new DomainError(
            'SUPERVISOR_OVERRIDE_REQUIRED',
            "Kassir pul yashigini qo'lda ochishi uchun rahbar PIN tasdig'i kerak",
          );
        }
        const supervisor = await this.authService.verifySupervisorPin(body.override);
        overrideApprovedByUserId = supervisor.id;
      }
      const config = this.configFor(
        toPrinterConfig(await this.printerStore.getPrinterSettings()),
        terminalId,
      );
      const current = await this.shiftStore.getCurrentShift();
      const out = await this.send(config, encodeCashDrawerPulse(0), 'Guzar pul yashigi');
      const saved = await this.printerStore.recordCashDrawerEvent({
        clientRequestId,
        shiftId: current.shift?.id ?? null,
        actorUserId: session.user.id,
        overrideApprovedByUserId,
        reason: body.reason,
        status: out.status,
        printerMode: config.mode,
        printerTarget: out.printerTarget,
        errorCode: out.errorCode,
        errorMessage: out.errorMessage,
      });
      return {
        response: { event: toCashDrawerDto(saved.row), idempotentReplay: saved.idempotentReplay },
        overrideApprovedByUserId: saved.row.overrideApprovedByUserId,
      };
    });
  }

  private async printDocument(params: {
    readonly documentType: ReceiptPrintDocumentType;
    readonly documentId: UuidV7;
    readonly session: AuthenticatedSessionSnapshot;
    readonly body: PrintDocumentRequestDto;
    readonly terminalId: UuidV7 | null;
    readonly jobTitle: string;
    readonly build: (ctx: {
      readonly config: PrinterConfig;
      readonly storeTimezone: string;
      readonly copyNumber: number;
      readonly isReprint: boolean;
    }) => Promise<PrintableDocument>;
  }): Promise<PrintDocumentResponseDto> {
    const clientRequestId = parseUuidV7(params.body.clientRequestId);
    return this.once(`print:${clientRequestId}`, async () => {
      const existing = await this.printerStore.findReceiptPrintByRequest(clientRequestId);
      if (existing) {
        return { printRecord: toReceiptPrintDto(existing), idempotentReplay: true };
      }
      const settings = await this.printerStore.getPrinterSettings();
      const config = this.configFor(toPrinterConfig(settings), params.terminalId);
      const history = await this.printerStore.getReceiptPrintHistorySummary(
        params.documentType,
        params.documentId,
      );
      const isReprint = params.body.reprint === true || history.successfulCount > 0;
      const copyNumber = isReprint ? Math.max(2, history.successfulCount + 1) : 1;
      const document = await params.build({
        config,
        storeTimezone: settings.storeTimezone,
        copyNumber,
        isReprint,
      });
      const encoded = encodeEscPosDocument({
        document,
        paperWidthMm: config.paperWidthMm,
        encoding: config.encoding,
      });
      const out = await this.send(config, encoded.bytes, params.jobTitle);
      const saved = await this.printerStore.recordReceiptPrint({
        documentType: params.documentType,
        documentId: params.documentId,
        clientRequestId,
        actorUserId: params.session.user.id,
        copyNumber,
        isReprint,
        status: out.status,
        printerMode: config.mode,
        printerTarget: out.printerTarget,
        bytesSent: out.bytesSent,
        errorCode: out.errorCode,
        errorMessage: out.errorMessage,
        textPreview: encoded.textPreview,
      });
      return {
        printRecord: toReceiptPrintDto(saved.row),
        idempotentReplay: saved.idempotentReplay,
      };
    });
  }

  /** The sale receipt as a printable document (shared by printing and the C22 preview). */
  private async buildSaleDocument(
    sale: NonNullable<Awaited<ReturnType<SqliteSaleStore['getSaleById']>>>,
    session: AuthenticatedSessionSnapshot,
    ctx: {
      readonly config: PrinterConfig;
      readonly storeTimezone: string;
      readonly copyNumber: number;
      readonly isReprint: boolean;
    },
  ): Promise<SaleReceiptDocument> {
    const { config, storeTimezone, copyNumber, isReprint } = ctx;
    const labels = await this.printerStore.getReceiptLabels({
      userIds: [sale.cashierUserId],
      customerId: sale.customerId,
      shiftId: sale.shiftId,
      customerBalanceAtMs: unixMsToBigInt(sale.createdAtMs),
    });
    const debtTiyin = moneyToTiyin(sale.debtAmount);
    const balanceAfter = labels.customerBalanceTiyin;
    const customerDebt =
      balanceAfter !== null && (balanceAfter > 0n || debtTiyin > 0n)
        ? { beforeTiyin: balanceAfter - debtTiyin, afterTiyin: balanceAfter }
        : undefined;
    const doc: SaleReceiptDocument = {
      kind: 'sale',
      ...(customerDebt !== undefined ? { customerDebt } : {}),
      lookupQr: sale.receiptCode,
      headerTitle: config.receiptHeaderTitle,
      footerText: config.receiptFooterText,
      receiptNo: sale.receiptNo,
      receiptCode: sale.receiptCode,
      shiftCode: labels.shiftCode ?? '-',
      cashierName: labels.userNames.get(sale.cashierUserId) ?? session.user.fullName,
      customerName: labels.customerName,
      formattedDateTime: formatUnixMsInTimezone(sale.createdAtMs, storeTimezone),
      copyNumber,
      isReprint,
      lines: sale.lines.map((l, idx) => ({
        lineNo: idx + 1,
        itemName: l.itemName,
        isQuickSale: l.lineKind === 'quick_sale',
        unit: l.unit,
        qtyMilli: quantityToMilli(l.qty),
        unitPriceTiyin: moneyToTiyin(l.unitPriceSnapshot),
        grossTotalTiyin: moneyToTiyin(l.grossTotal),
        promoDiscountTiyin: moneyToTiyin(l.promoDiscount),
        allocatedOrderDiscountTiyin: moneyToTiyin(l.allocatedOrderDiscount),
        finalTotalTiyin: moneyToTiyin(l.finalTotal),
        vatRateBp: l.vatRateBpSnapshot,
        vatTotalTiyin: moneyToTiyin(l.vatTotal),
      })),
      subtotalGrossTiyin: moneyToTiyin(sale.subtotalGross),
      promoDiscountTotalTiyin: moneyToTiyin(sale.totalPromoDiscount),
      orderDiscountTotalTiyin: moneyToTiyin(sale.orderDiscountAmount),
      totalFinalTiyin: moneyToTiyin(sale.totalFinal),
      totalVatTiyin: moneyToTiyin(sale.totalVat),
      paidAmountTiyin: moneyToTiyin(sale.totalPaid),
      debtAmountTiyin: moneyToTiyin(sale.debtAmount),
      changeAmountTiyin: moneyToTiyin(sale.changeAmount),
      payments: sale.payments.map((p) => ({
        method: p.method,
        amountTiyin: moneyToTiyin(p.amount),
        tenderedAmountTiyin: p.tenderedAmount !== null ? moneyToTiyin(p.tenderedAmount) : null,
        providerRef: p.providerRef,
      })),
      openCashDrawer:
        !isReprint && config.cashDrawerAutoOpen && sale.payments.some((p) => p.method === 'cash'),
      fiscal: this.resolveFiscalBlock({ saleId: sale.id }),
    };
    return doc;
  }

  /**
   * C22: the sale receipt as plain text (the same layout the receipt printer gets), for sharing it
   * as a picture or printing it on an office printer. Records no print and opens no drawer.
   */
  async previewSaleReceipt(
    saleIdRaw: string,
    session: AuthenticatedSessionSnapshot,
    paperWidthMm: 58 | 80,
  ): Promise<{
    readonly receiptCode: string;
    readonly text: string;
    readonly shopTitle: string;
    readonly customerName: string | null;
    readonly dateText: string;
  }> {
    const sale = await this.saleStore.getSaleById(parseUuidV7(saleIdRaw));
    if (sale === null) {
      throw new DomainError('SALE_NOT_FOUND', 'Chek topilmadi');
    }
    const settings = await this.printerStore.getPrinterSettings();
    const config = toPrinterConfig(settings);
    const doc = await this.buildSaleDocument(sale, session, {
      config: { ...config, cashDrawerAutoOpen: false },
      storeTimezone: settings.storeTimezone,
      copyNumber: 1,
      isReprint: false,
    });
    const encoded = encodeEscPosDocument({ document: doc, paperWidthMm, encoding: 'translit' });
    return {
      receiptCode: sale.receiptCode,
      text: encoded.textPreview,
      shopTitle: doc.headerTitle,
      customerName: doc.customerName,
      dateText: doc.formattedDateTime,
    };
  }

  async printSaleReceipt(
    saleIdRaw: string,
    session: AuthenticatedSessionSnapshot,
    body: PrintDocumentRequestDto,
    terminalId: UuidV7 | null = null,
  ): Promise<PrintDocumentResponseDto> {
    const saleId = parseUuidV7(saleIdRaw);
    const sale = await this.saleStore.getSaleById(saleId);
    if (sale === null) {
      throw new DomainError('SALE_NOT_FOUND', 'Chek topilmadi');
    }
    return this.printDocument({
      documentType: 'sale',
      documentId: saleId,
      session,
      body,
      terminalId,
      jobTitle: `Guzar chek ${sale.receiptCode}`,
      build: async (ctx) => this.buildSaleDocument(sale, session, ctx),
    });
  }

  async listSalePrints(saleIdRaw: string): Promise<ListReceiptPrintsResponseDto> {
    const rows = await this.printerStore.listReceiptPrints('sale', parseUuidV7(saleIdRaw));
    return { prints: [...rows].reverse().map(toReceiptPrintDto) };
  }

  async printReturnReceipt(
    returnIdRaw: string,
    session: AuthenticatedSessionSnapshot,
    body: PrintDocumentRequestDto,
    terminalId: UuidV7 | null = null,
  ): Promise<PrintDocumentResponseDto> {
    const returnId = parseUuidV7(returnIdRaw);
    const ret = await this.returnStore.getReturnById(returnId);
    if (ret === null) {
      throw new DomainError('RETURN_NOT_FOUND', 'Qaytarish topilmadi');
    }
    const sale = await this.saleStore.getSaleById(ret.saleId);
    return this.printDocument({
      documentType: 'return',
      documentId: returnId,
      session,
      body,
      terminalId,
      jobTitle: `Guzar qaytarish ${ret.returnCode}`,
      build: async ({ config, storeTimezone, copyNumber, isReprint }) => {
        const labels = await this.printerStore.getReceiptLabels({
          userIds: [ret.processedByUserId],
          customerId: null,
          shiftId: ret.shiftId ?? sale?.shiftId ?? null,
        });
        const doc: ReturnReceiptDocument = {
          kind: 'return',
          headerTitle: config.receiptHeaderTitle,
          footerText: config.receiptFooterText,
          returnNo: ret.returnNo,
          returnCode: ret.returnCode,
          saleReceiptCode: sale?.receiptCode ?? '-',
          shiftCode: labels.shiftCode ?? '-',
          actorName: labels.userNames.get(ret.processedByUserId) ?? session.user.fullName,
          reason: ret.reason,
          formattedDateTime: formatUnixMsInTimezone(ret.createdAtMs, storeTimezone),
          copyNumber,
          isReprint,
          lines: ret.lines.map((l, idx) => ({
            lineNo: idx + 1,
            itemName: l.itemName,
            unit: l.unit,
            qtyMilli: quantityToMilli(l.qty),
            unitPriceTiyin: moneyToTiyin(l.unitPriceSnapshot),
            refundAmountTiyin: moneyToTiyin(l.refundAmount),
            vatTotalTiyin: moneyToTiyin(l.vatTotal),
          })),
          totalRefundTiyin: moneyToTiyin(ret.totalRefund),
          totalVatTiyin: moneyToTiyin(ret.totalVat),
          payments: ret.payments.map((p) => ({
            method: p.method,
            amountTiyin: moneyToTiyin(p.amount),
            providerRef: p.providerRef,
          })),
          openCashDrawer:
            !isReprint && config.cashDrawerAutoOpen && moneyToTiyin(ret.cashRefundAmount) > 0n,
          fiscal: this.resolveFiscalBlock({ returnId: ret.id }),
        };
        return doc;
      },
    });
  }

  async printShiftCloseReport(
    shiftIdRaw: string,
    session: AuthenticatedSessionSnapshot,
    body: PrintDocumentRequestDto,
    terminalId: UuidV7 | null = null,
  ): Promise<PrintDocumentResponseDto> {
    const shiftId = parseUuidV7(shiftIdRaw);
    const detail = await this.shiftStore.getShiftDetail(shiftId);
    const closure = detail.closures[detail.closures.length - 1];
    if (!closure) {
      throw new DomainError(
        'SHIFT_NOT_OPEN',
        'Smena hali yopilmagan: faqat yopilgan smena hisobotini chop etish mumkin',
      );
    }
    const sumMoves = (types: readonly string[]): bigint =>
      detail.cashMoves
        .filter((m) => types.includes(m.type))
        .reduce((acc, m) => acc + moneyToTiyin(m.amountDelta), 0n);
    const abs = (v: bigint): bigint => (v < 0n ? -v : v);
    const cashRow = closure.methodTotals.find((m) => m.method === 'cash');
    const nonCash = closure.methodTotals.filter((m) => m.method !== 'cash');
    return this.printDocument({
      documentType: 'shift_close',
      documentId: shiftId,
      session,
      body,
      terminalId,
      jobTitle: `Guzar smena ${detail.shift.shiftCode}`,
      build: async ({ config, storeTimezone, copyNumber, isReprint }) => {
        const labels = await this.printerStore.getReceiptLabels({
          userIds: [closure.closedByUserId],
          customerId: null,
          shiftId: null,
        });
        const doc: ShiftCloseReportDocument = {
          kind: 'shift_close',
          headerTitle: config.receiptHeaderTitle,
          shiftCode: detail.shift.shiftCode,
          closeSeq: closure.closureSeq,
          closedByName: labels.userNames.get(closure.closedByUserId) ?? session.user.fullName,
          openedAtFormatted: formatUnixMsInTimezone(detail.shift.openedAtMs, storeTimezone),
          closedAtFormatted: formatUnixMsInTimezone(closure.createdAtMs, storeTimezone),
          copyNumber,
          isReprint,
          salesCount: closure.salesCount,
          returnsCount: closure.returnsCount,
          voidsCount: closure.voidsCount,
          grossSalesTiyin: moneyToTiyin(closure.grossSalesTotal),
          returnsTotalTiyin: moneyToTiyin(closure.returnsTotal),
          netSalesTiyin: moneyToTiyin(closure.netSalesTotal),
          openingCashTiyin: moneyToTiyin(detail.shift.openingCash),
          cashSalesNetTiyin: cashRow ? moneyToTiyin(cashRow.salesAmount) : 0n,
          cashReturnsTotalTiyin: cashRow ? moneyToTiyin(cashRow.returnsAmount) : 0n,
          cashInTotalTiyin: sumMoves(['cash_in']),
          cashOutTotalTiyin: abs(sumMoves(['encashment'])),
          expenseTotalTiyin: abs(sumMoves(['cash_out'])),
          expectedCashTiyin: moneyToTiyin(closure.expectedCash),
          countedCashTiyin: moneyToTiyin(closure.countedCash),
          cashDiscrepancyTiyin: moneyToTiyin(closure.discrepancy),
          nonCashNetTotalTiyin: nonCash.reduce((acc, m) => acc + moneyToTiyin(m.netAmount), 0n),
          nonCashByMethod: nonCash.map((m) => ({
            method: m.method,
            netAmountTiyin: moneyToTiyin(m.netAmount),
          })),
        };
        return doc;
      },
    });
  }
}
