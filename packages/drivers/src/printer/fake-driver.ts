import type { PrinterDriver, PrinterMode, PrintSendResult } from './types.js';

export interface FakePrintJob {
  readonly bytes: Uint8Array;
  readonly jobTitle: string | undefined;
}

export interface FakePrinterFailureConfig {
  readonly errorCode: string;
  readonly errorMessage: string;
}

/**
 * In-memory deterministic `FakePrinterDriver` for unit, integration, and E2E tests.
 * Captures every `Uint8Array` buffer sent and supports simulated failure or latency.
 */
export class FakePrinterDriver implements PrinterDriver {
  public readonly mode: PrinterMode;
  public readonly target: string;
  private readonly jobs: FakePrintJob[] = [];
  private failure: FakePrinterFailureConfig | null = null;
  private delayMs = 0;

  public constructor(options?: { readonly mode?: PrinterMode; readonly target?: string }) {
    this.mode = options?.mode ?? 'network_tcp';
    this.target = options?.target ?? '127.0.0.1:9100';
  }

  public getSentJobs(): readonly FakePrintJob[] {
    return this.jobs;
  }

  public clearJobs(): void {
    this.jobs.length = 0;
  }

  public setSimulateFailure(failure: FakePrinterFailureConfig | null): void {
    this.failure = failure;
  }

  public setSimulateDelayMs(delayMs: number): void {
    this.delayMs = Math.max(0, delayMs);
  }

  public async sendRaw(bytes: Uint8Array, jobTitle?: string): Promise<PrintSendResult> {
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    }

    if (this.failure !== null) {
      return {
        ok: false,
        mode: this.mode,
        target: this.target,
        errorCode: this.failure.errorCode,
        errorMessage: this.failure.errorMessage,
      };
    }

    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    this.jobs.push({ bytes: copy, jobTitle });

    return {
      ok: true,
      mode: this.mode,
      target: this.target,
      bytesSent: copy.length,
    };
  }
}
