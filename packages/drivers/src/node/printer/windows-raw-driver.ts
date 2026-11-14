import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import type {
  DiscoveredWindowsPrinter,
  PrinterDriver,
  PrintSendResult,
} from '../../printer/types.js';

export interface WinspoolBindings {
  OpenPrinterW(printerName: string): { readonly ok: boolean; readonly handle: unknown };
  StartDocPrinterW(handle: unknown, docTitle: string): number;
  StartPagePrinter(handle: unknown): boolean;
  WritePrinter(
    handle: unknown,
    bytes: Uint8Array,
  ): { readonly ok: boolean; readonly bytesWritten: number };
  EndPagePrinter(handle: unknown): boolean;
  EndDocPrinter(handle: unknown): boolean;
  ClosePrinter(handle: unknown): boolean;
}

interface KoffiModuleLike {
  load(libName: string): unknown;
  struct(name: string, fields: Record<string, string>): unknown;
  pointer(typeName: string): unknown;
  out(type: unknown): unknown;
}

let cachedNativeWinspool: WinspoolBindings | null = null;

function getNativeWinspoolBindings(): WinspoolBindings {
  if (cachedNativeWinspool !== null) {
    return cachedNativeWinspool;
  }

  const require = createRequire(import.meta.url);
  const koffi = require('koffi') as KoffiModuleLike & {
    func?: unknown;
  };
  const winspool = koffi.load('winspool.drv') as {
    func(signature: string): (...args: unknown[]) => unknown;
  };

  koffi.struct('MEZON_DOC_INFO_1W', {
    pDocName: 'str16',
    pOutputFile: 'str16',
    pDatatype: 'str16',
  });

  const openPrinterFn = winspool.func(
    'int __stdcall OpenPrinterW(str16 pPrinterName, _Out_ void **phPrinter, void *pDefault)',
  );
  const startDocPrinterFn = winspool.func(
    'uint32_t __stdcall StartDocPrinterW(void *hPrinter, uint32_t Level, MEZON_DOC_INFO_1W *pDocInfo)',
  );
  const startPagePrinterFn = winspool.func('int __stdcall StartPagePrinter(void *hPrinter)');
  const writePrinterFn = winspool.func(
    'int __stdcall WritePrinter(void *hPrinter, const uint8_t *pBuf, uint32_t cbBuf, _Out_ uint32_t *pcWritten)',
  );
  const endPagePrinterFn = winspool.func('int __stdcall EndPagePrinter(void *hPrinter)');
  const endDocPrinterFn = winspool.func('int __stdcall EndDocPrinter(void *hPrinter)');
  const closePrinterFn = winspool.func('int __stdcall ClosePrinter(void *hPrinter)');

  cachedNativeWinspool = {
    OpenPrinterW(printerName: string) {
      const handleOut: unknown[] = [null];
      const res = Number(openPrinterFn(printerName, handleOut, null));
      return {
        ok: res !== 0 && handleOut[0] !== null && handleOut[0] !== undefined,
        handle: handleOut[0] ?? null,
      };
    },
    StartDocPrinterW(handle: unknown, docTitle: string) {
      const docInfo = {
        pDocName: docTitle,
        pOutputFile: null,
        pDatatype: 'RAW',
      };
      return Number(startDocPrinterFn(handle, 1, docInfo));
    },
    StartPagePrinter(handle: unknown) {
      return Number(startPagePrinterFn(handle)) !== 0;
    },
    WritePrinter(handle: unknown, bytes: Uint8Array) {
      const writtenOut: number[] = [0];
      const res = Number(writePrinterFn(handle, bytes, bytes.byteLength, writtenOut));
      return {
        ok: res !== 0,
        bytesWritten: Number(writtenOut[0] ?? 0),
      };
    },
    EndPagePrinter(handle: unknown) {
      return Number(endPagePrinterFn(handle)) !== 0;
    },
    EndDocPrinter(handle: unknown) {
      return Number(endDocPrinterFn(handle)) !== 0;
    },
    ClosePrinter(handle: unknown) {
      return Number(closePrinterFn(handle)) !== 0;
    },
  };

  return cachedNativeWinspool;
}

export interface WindowsRawPrinterDriverOptions {
  readonly printerName: string;
  readonly bindings?: WinspoolBindings;
  readonly platform?: NodeJS.Platform;
}

/**
 * Windows `winspool.drv` RAW printer driver via `koffi` 3.
 * Executes `OpenPrinterW -> StartDocPrinterW(Level=1, pDatatype="RAW") -> StartPagePrinter -> WritePrinter -> EndPagePrinter -> EndDocPrinter -> ClosePrinter`
 * and guarantees handle cleanup in `finally` blocks.
 */
export class WindowsRawPrinterDriver implements PrinterDriver {
  public readonly mode = 'windows_raw' as const;
  private readonly printerName: string;
  private readonly customBindings: WinspoolBindings | undefined;
  private readonly platform: NodeJS.Platform;

  public constructor(options: WindowsRawPrinterDriverOptions) {
    this.printerName = options.printerName.trim();
    this.customBindings = options.bindings;
    this.platform = options.platform ?? process.platform;
  }

  public sendRaw(bytes: Uint8Array, jobTitle = 'Mezon Kassa Receipt'): Promise<PrintSendResult> {
    if (this.printerName.length === 0) {
      return Promise.resolve({
        ok: false,
        mode: 'windows_raw',
        target: null,
        errorCode: 'PRINTER_NAME_EMPTY',
        errorMessage: 'Windows printer nomi tanlanmagan',
      });
    }

    if (this.platform !== 'win32' && this.customBindings === undefined) {
      return Promise.resolve({
        ok: false,
        mode: 'windows_raw',
        target: this.printerName,
        errorCode: 'PRINTER_OS_UNSUPPORTED',
        errorMessage: `Windows RAW printer faqat Windows OS da ishlaydi (joriy OS: ${this.platform})`,
      });
    }

    let bindings: WinspoolBindings;
    try {
      bindings = this.customBindings ?? getNativeWinspoolBindings();
    } catch (err) {
      return Promise.resolve({
        ok: false,
        mode: 'windows_raw',
        target: this.printerName,
        errorCode: 'PRINTER_WINSPOOL_LOAD_FAILED',
        errorMessage: `winspool.drv yuklashda xato: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    let handle: unknown = null;
    let docStarted = false;
    let pageStarted = false;

    try {
      const opened = bindings.OpenPrinterW(this.printerName);
      if (!opened.ok || opened.handle === null || opened.handle === undefined) {
        return Promise.resolve({
          ok: false,
          mode: 'windows_raw',
          target: this.printerName,
          errorCode: 'PRINTER_OPEN_FAILED',
          errorMessage: `Windows printerini ochib bo'lmadi: "${this.printerName}"`,
        });
      }
      handle = opened.handle;

      const jobId = bindings.StartDocPrinterW(handle, jobTitle);
      if (!Number.isInteger(jobId) || jobId <= 0) {
        return Promise.resolve({
          ok: false,
          mode: 'windows_raw',
          target: this.printerName,
          errorCode: 'PRINTER_START_DOC_FAILED',
          errorMessage: `Windows printerida RAW hujjatni boshlab bo'lmadi: "${this.printerName}"`,
        });
      }
      docStarted = true;

      if (!bindings.StartPagePrinter(handle)) {
        return Promise.resolve({
          ok: false,
          mode: 'windows_raw',
          target: this.printerName,
          errorCode: 'PRINTER_START_PAGE_FAILED',
          errorMessage: `Windows printerida sahifani boshlab bo'lmadi: "${this.printerName}"`,
        });
      }
      pageStarted = true;

      const written = bindings.WritePrinter(handle, bytes);
      if (!written.ok || written.bytesWritten !== bytes.byteLength) {
        return Promise.resolve({
          ok: false,
          mode: 'windows_raw',
          target: this.printerName,
          errorCode: 'PRINTER_WRITE_FAILED',
          errorMessage: `Windows printeriga baytlarni yozishda xato (${String(written.bytesWritten)}/${String(bytes.byteLength)} bayt)`,
        });
      }

      return Promise.resolve({
        ok: true,
        mode: 'windows_raw',
        target: this.printerName,
        bytesSent: written.bytesWritten,
      });
    } catch (err) {
      return Promise.resolve({
        ok: false,
        mode: 'windows_raw',
        target: this.printerName,
        errorCode: 'PRINTER_WINSPOOL_EXCEPTION',
        errorMessage: `Windows printer xatosi: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      if (handle !== null && handle !== undefined) {
        try {
          if (pageStarted) {
            bindings.EndPagePrinter(handle);
          }
        } catch {
          // Ignore cleanup errors
        }
        try {
          if (docStarted) {
            bindings.EndDocPrinter(handle);
          }
        } catch {
          // Ignore cleanup errors
        }
        try {
          bindings.ClosePrinter(handle);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }
}

/**
 * Lists installed Windows printers safely without blocking the event loop.
 * Returns an empty array on non-Windows platforms or if spooler enumeration fails.
 */
export function listInstalledWindowsPrinters(
  platform: NodeJS.Platform = process.platform,
): Promise<readonly DiscoveredWindowsPrinter[]> {
  if (platform !== 'win32') {
    return Promise.resolve([]);
  }

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance -ClassName Win32_Printer | Select-Object Name, Default | ConvertTo-Json -Compress',
      ],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout || stdout.trim().length === 0) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as unknown;
          const items = Array.isArray(parsed) ? parsed : [parsed];
          const printers: DiscoveredWindowsPrinter[] = [];
          for (const item of items) {
            if (item && typeof item === 'object' && 'Name' in item) {
              const rawName = (item as { Name?: unknown }).Name;
              const rawDefault = (item as { Default?: unknown }).Default;
              if (typeof rawName === 'string' && rawName.trim().length > 0) {
                printers.push({
                  name: rawName.trim(),
                  isDefault: Boolean(rawDefault),
                });
              }
            }
          }
          resolve(printers);
        } catch {
          resolve([]);
        }
      },
    );
  });
}
