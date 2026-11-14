import type { PrinterDriver, PrintSendResult } from './types.js';

/**
 * Printerless mode driver (`mode = 'disabled'`).
 * Performs no I/O and returns a clean disabled result.
 */
export class NullPrinterDriver implements PrinterDriver {
  public readonly mode = 'disabled' as const;

  public sendRaw(_bytes: Uint8Array, _jobTitle?: string): Promise<PrintSendResult> {
    return Promise.resolve({
      ok: true,
      mode: 'disabled',
      target: null,
      bytesSent: 0,
    });
  }
}
