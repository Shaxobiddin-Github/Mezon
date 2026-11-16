import ExcelJS from 'exceljs';
import {
  DomainError,
  MAX_MONEY_TIYIN,
  formatMoneyDecimal,
  formatQuantityDecimal,
  moneyFromTiyin,
  type ProductUnit,
  isProductUnit,
  moneyToTiyin,
  normalizeFiscalCode,
  parseMoneyDecimal,
  parseQuantityDecimal,
  quantityFromMilli,
  quantityToMilli,
  validateQuantityForUnit,
  vatRateFromBasisPoints,
} from '@mezon/domain';
import type {
  DailySalesReportResult,
  DebtsReportResult,
  StoredProductRecord,
} from '@mezon/db-local';

export interface ExcelImportParsedRow {
  readonly rowNumber: number;
  readonly name: string;
  readonly sku?: string | null;
  readonly barcode?: string | null;
  readonly unit: string;
  readonly salePriceTiyin: bigint;
  readonly costPriceTiyin?: bigint | null;
  readonly minStockMilli?: bigint | null;
  /** T3.1 fiscal columns (7: MXIK, 8: Qadoq kodi, 9: QQS %). */
  readonly mxik?: string | null;
  readonly packageCode?: string | null;
  readonly vatRateBp?: number;
  readonly error?: string;
  /** Stable i18n key for row errors (`excelImport.error.*`). */
  readonly errorCode?: string;
}

export interface ParseImportWorkbookOptions {
  /** VAT basis points applied when the QQS cell is empty (organization default, else 0). */
  readonly defaultVatRateBp?: number;
}

/** Column order shared by catalog import AND export so an exported file re-imports unchanged. */
export const CATALOG_SHEET_COLUMNS = [
  { header: 'Nomi', key: 'name', width: 30 },
  { header: 'Artikul (SKU)', key: 'sku', width: 16 },
  { header: 'Shtrix-kod', key: 'barcode', width: 18 },
  { header: 'Oʻlchov birligi', key: 'unit', width: 15 },
  { header: 'Sotish narxi (soʻm)', key: 'salePrice', width: 18 },
  { header: 'Minimal zaxira', key: 'minStock', width: 15 },
  { header: 'MXIK', key: 'mxik', width: 22 },
  { header: 'Qadoq kodi', key: 'packageCode', width: 14 },
  { header: 'QQS (%)', key: 'vatPercent', width: 10 },
] as const;

class ImportRowError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Normalizes a spreadsheet decimal cell into the strict domain decimal syntax WITHOUT floats:
 * removes (narrow) no-break and regular spaces used as thousands separators and turns a single
 * decimal comma into a dot. Mixed comma+dot input is ambiguous and left for the parser to reject.
 */
export function normalizeSpreadsheetDecimal(raw: string): string {
  const compact = raw.replace(/[\s\u00A0\u202F]/g, '');
  if (compact.includes(',') && !compact.includes('.')) {
    const parts = compact.split(',');
    if (parts.length === 2) {
      return `${parts[0] ?? ''}.${parts[1] ?? ''}`;
    }
  }
  return compact;
}

/** Parses a spreadsheet money cell ("1 500,50", "1500.5") into tiyin using the domain parser. */
export function parseSpreadsheetMoneyTiyin(raw: string): bigint {
  return moneyToTiyin(parseMoneyDecimal(normalizeSpreadsheetDecimal(raw)));
}

/** Parses a spreadsheet quantity cell into milli-units using the domain parser. */
export function parseSpreadsheetQuantityMilli(raw: string): bigint {
  return quantityToMilli(parseQuantityDecimal(normalizeSpreadsheetDecimal(raw)));
}

/**
 * Parses a VAT percent cell ("12", "12%", "12,5") into basis points without floats: a percent with
 * up to 2 decimals has exactly the scale of tiyin, so the domain money parser yields bp directly.
 */
export function parseSpreadsheetVatPercentBp(raw: string): number {
  const trimmed = normalizeSpreadsheetDecimal(raw).replace(/%$/, '');
  const bp = moneyToTiyin(parseMoneyDecimal(trimmed));
  return Number(vatRateFromBasisPoints(bp));
}

export interface ParseImportWorkbookResult {
  readonly totalRows: number;
  readonly validRows: readonly ExcelImportParsedRow[];
  readonly invalidRows: readonly ExcelImportParsedRow[];
}

export class ExcelPort {
  /**
   * Generates Daily Sales Excel report.
   * If includeCost is false, COGS and Gross Profit columns are omitted completely (for cashier/manager).
   */
  public static async generateDailySalesWorkbook(
    report: DailySalesReportResult,
    options: { readonly includeCost: boolean },
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Guzar Hub';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Kunlik savdo');

    const columns: Partial<ExcelJS.Column>[] = [
      { header: 'Sana', key: 'date', width: 14 },
      { header: 'Cheklar soni', key: 'salesCount', width: 14 },
      { header: 'Qaytarishlar soni', key: 'returnsCount', width: 16 },
      { header: 'Jami tushum (soʻm)', key: 'grossSales', width: 20 },
      { header: 'Qaytarish summasi (soʻm)', key: 'returnsTotal', width: 22 },
      { header: 'Sof savdo (soʻm)', key: 'netSales', width: 20 },
      { header: 'Naqd (soʻm)', key: 'cashSales', width: 18 },
      { header: 'Naqd pulsiz (soʻm)', key: 'nonCashSales', width: 18 },
    ];

    if (options.includeCost) {
      columns.push(
        { header: 'Tannarx (soʻm)', key: 'costValue', width: 20 },
        { header: 'Yalpi foyda (soʻm)', key: 'grossProfit', width: 20 },
      );
    }

    sheet.columns = columns;

    // Header styling
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEFEFEF' },
    };

    for (const d of report.days) {
      const rowData: Record<string, string | number> = {
        date: d.date,
        salesCount: d.salesCount,
        returnsCount: d.returnsCount,
        grossSales: Number(moneyToTiyin(d.grossSales) / 100n),
        returnsTotal: Number(moneyToTiyin(d.returnsTotal) / 100n),
        netSales: Number(moneyToTiyin(d.netSales) / 100n),
        cashSales: Number(moneyToTiyin(d.cashSales) / 100n),
        nonCashSales: Number(moneyToTiyin(d.nonCashSales) / 100n),
      };

      if (options.includeCost && d.costValue && d.grossProfit) {
        rowData.costValue = Number(moneyToTiyin(d.costValue) / 100n);
        rowData.grossProfit = Number(moneyToTiyin(d.grossProfit) / 100n);
      }

      sheet.addRow(rowData);
    }

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Generates Customer & Supplier Debts Excel report.
   */
  public static async generateDebtsWorkbook(report: DebtsReportResult): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Guzar Hub';
    workbook.created = new Date();

    const custSheet = workbook.addWorksheet('Mijozlar qarzi');
    custSheet.columns = [
      { header: 'Mijoz F.I.Sh', key: 'fullName', width: 30 },
      { header: 'Telefon', key: 'phone', width: 18 },
      { header: 'Umumiy qarz (soʻm)', key: 'balance', width: 20 },
      { header: 'Muddati oʻtgan qarz (soʻm)', key: 'overdueAmount', width: 25 },
    ];
    custSheet.getRow(1).font = { bold: true };

    for (const c of report.customers) {
      custSheet.addRow({
        fullName: c.fullName,
        phone: c.phone ?? '-',
        balance: Number(moneyToTiyin(c.balance) / 100n),
        overdueAmount: Number(moneyToTiyin(c.overdueAmount) / 100n),
      });
    }

    const supSheet = workbook.addWorksheet('Yetkazib beruvchilar qarzi');
    supSheet.columns = [
      { header: 'Yetkazib beruvchi', key: 'name', width: 30 },
      { header: 'Qarz (soʻm)', key: 'balance', width: 20 },
    ];
    supSheet.getRow(1).font = { bold: true };

    for (const s of report.suppliers) {
      supSheet.addRow({
        name: s.name,
        balance: Number(moneyToTiyin(s.balance) / 100n),
      });
    }

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Generates Catalog Excel export.
   * Omits cost price for non-owner callers.
   */
  public static async generateCatalogWorkbook(
    products: readonly StoredProductRecord[],
    _options: {
      readonly includeCost: boolean;
      readonly barcodeByProductId?: ReadonlyMap<string, string>;
    },
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Guzar Hub';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Mahsulotlar');
    const cols: Partial<ExcelJS.Column>[] = CATALOG_SHEET_COLUMNS.map((c) => ({ ...c }));

    sheet.columns = cols;
    sheet.getRow(1).font = { bold: true };

    for (const p of products) {
      // T3.1: exact decimal TEXT cells (no float/truncation) in import column order so the
      // exported workbook re-imports to identical values.
      const rowData: Record<string, string> = {
        name: p.name,
        sku: p.sku ?? '',
        barcode: _options.barcodeByProductId?.get(p.id) ?? '',
        unit: p.unit,
        salePrice: formatMoneyDecimal(p.salePrice),
        minStock: p.minStock ? formatQuantityDecimal(p.minStock) : '',
        mxik: p.mxik ?? '',
        packageCode: p.packageCode ?? '',
        vatPercent: formatMoneyDecimal(moneyFromTiyin(BigInt(p.vatRateBp))),
      };

      sheet.addRow(rowData);
    }

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Normalizes barcode string, e.g. trims whitespace, handles 12-digit UPC-A by padding to 13 digits if appropriate.
   */
  public static normalizeBarcode(raw: string): string {
    const trimmed = raw.trim();
    if (/^\d{12}$/.test(trimmed)) {
      return `0${trimmed}`;
    }
    return trimmed;
  }

  /**
   * Parses uploaded Excel workbook for product import (max 5000 rows).
   */
  public static async parseImportWorkbook(
    buffer: Buffer,
    options: ParseImportWorkbookOptions = {},
  ): Promise<ParseImportWorkbookResult> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

    const sheet = workbook.worksheets[0];
    if (!sheet) {
      return { totalRows: 0, validRows: [], invalidRows: [] };
    }

    const validRows: ExcelImportParsedRow[] = [];
    const invalidRows: ExcelImportParsedRow[] = [];

    let totalDataRows = 0;

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header row
      totalDataRows++;

      if (totalDataRows > 5000) {
        invalidRows.push({
          rowNumber,
          name: 'LIMIT_EXCEEDED',
          unit: 'dona',
          salePriceTiyin: 0n,
          error: 'Maksimal 5,000 qator ruxsat etiladi',
        });
        return;
      }

      const getCellString = (idx: number): string => {
        const val = row.getCell(idx).value;
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') {
          if ('text' in val && typeof (val as { text?: unknown }).text === 'string') {
            return (val as { text: string }).text.trim();
          }
          if (
            'result' in val &&
            (typeof val.result === 'string' || typeof val.result === 'number')
          ) {
            return String(val.result).trim();
          }
          return '';
        }
        if (
          typeof val === 'string' ||
          typeof val === 'number' ||
          typeof val === 'boolean' ||
          typeof val === 'bigint'
        ) {
          return String(val).trim();
        }
        return '';
      };

      const name = getCellString(1);
      const skuRaw = getCellString(2);
      const barcodeRaw = getCellString(3);
      const unitRaw = getCellString(4).toLowerCase();
      const priceRaw = getCellString(5);
      const minStockRaw = getCellString(6);
      const mxikRaw = getCellString(7);
      const packageCodeRaw = getCellString(8);
      const vatRaw = getCellString(9);

      if (!name) {
        invalidRows.push({
          rowNumber,
          name: '',
          unit: unitRaw || 'dona',
          salePriceTiyin: 0n,
          error: 'Mahsulot nomi kiritilmagan',
          errorCode: 'excelImport.error.nameMissing',
        });
        return;
      }

      const unit: ProductUnit = isProductUnit(unitRaw) ? unitRaw : 'dona';
      const barcode = barcodeRaw ? ExcelPort.normalizeBarcode(barcodeRaw) : null;

      try {
        // Price: strict decimal (≤ 2 fraction digits), positive, within signed int64 tiyin.
        let salePriceTiyin: bigint;
        try {
          salePriceTiyin = parseSpreadsheetMoneyTiyin(priceRaw);
        } catch {
          throw new ImportRowError('excelImport.error.invalidPrice', 'Sotish narxi notoʻgʻri');
        }
        if (salePriceTiyin <= 0n || salePriceTiyin > MAX_MONEY_TIYIN) {
          throw new ImportRowError('excelImport.error.invalidPrice', 'Sotish narxi notoʻgʻri');
        }

        let minStockMilli: bigint | null = null;
        if (minStockRaw) {
          try {
            minStockMilli = parseSpreadsheetQuantityMilli(minStockRaw);
          } catch {
            throw new ImportRowError(
              'excelImport.error.invalidMinStock',
              'Minimal zaxira notoʻgʻri',
            );
          }
          if (minStockMilli < 0n) {
            throw new ImportRowError(
              'excelImport.error.invalidMinStock',
              'Minimal zaxira notoʻgʻri',
            );
          }
          try {
            validateQuantityForUnit(unit, quantityFromMilli(minStockMilli), { allowZero: true });
          } catch {
            throw new ImportRowError(
              'excelImport.error.invalidMinStock',
              'Minimal zaxira notoʻgʻri',
            );
          }
        }

        let mxik: string | null;
        try {
          mxik = normalizeFiscalCode(mxikRaw, 'MXIK');
        } catch {
          throw new ImportRowError('excelImport.error.invalidMxik', 'MXIK kodi notoʻgʻri');
        }

        let packageCode: string | null;
        try {
          packageCode = normalizeFiscalCode(packageCodeRaw, 'Package code');
        } catch {
          throw new ImportRowError('excelImport.error.invalidPackageCode', 'Qadoq kodi notoʻgʻri');
        }

        let vatRateBp = options.defaultVatRateBp ?? 0;
        if (vatRaw) {
          try {
            vatRateBp = parseSpreadsheetVatPercentBp(vatRaw);
          } catch {
            throw new ImportRowError('excelImport.error.invalidVat', 'QQS stavkasi notoʻgʻri');
          }
        }

        validRows.push({
          rowNumber,
          name,
          sku: skuRaw || null,
          barcode,
          unit,
          salePriceTiyin,
          minStockMilli,
          mxik,
          packageCode,
          vatRateBp,
        });
      } catch (err) {
        if (!(err instanceof ImportRowError) && !(err instanceof DomainError)) {
          throw err;
        }
        invalidRows.push({
          rowNumber,
          name,
          sku: skuRaw || null,
          barcode,
          unit,
          salePriceTiyin: 0n,
          error: err.message,
          errorCode: err instanceof ImportRowError ? err.code : 'excelImport.error.invalidRow',
        });
      }
    });

    return {
      totalRows: totalDataRows,
      validRows,
      invalidRows,
    };
  }
}
