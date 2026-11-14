import net from 'node:net';
import {
  isAllowedLocalPrinterIpv4,
  type PrinterDriver,
  type PrintSendResult,
} from '../../printer/types.js';

export interface NetworkPrinterDriverOptions {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs?: number;
}

/**
 * Raw TCP 9100 network receipt printer driver (`node:net`).
 * Enforces P2 local IPv4 restriction (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `127/8`)
 * and strict socket timeout (`timeoutMs`, default 3000ms) so offline printers never hang the Hub.
 */
export class NetworkPrinterDriver implements PrinterDriver {
  public readonly mode = 'network_tcp' as const;
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;

  public constructor(options: NetworkPrinterDriverOptions) {
    this.host = options.host.trim();
    this.port = options.port;
    this.timeoutMs = Math.max(200, Math.min(30_000, options.timeoutMs ?? 3000));
  }

  public get target(): string {
    return `${this.host}:${String(this.port)}`;
  }

  public async sendRaw(bytes: Uint8Array, _jobTitle?: string): Promise<PrintSendResult> {
    if (!isAllowedLocalPrinterIpv4(this.host)) {
      return {
        ok: false,
        mode: 'network_tcp',
        target: this.target,
        errorCode: 'PRINTER_INVALID_HOST',
        errorMessage: `Tarmoq printeri manzili ruxsat etilmagan: ${this.host}`,
      };
    }
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) {
      return {
        ok: false,
        mode: 'network_tcp',
        target: this.target,
        errorCode: 'PRINTER_INVALID_PORT',
        errorMessage: `Tarmoq printeri porti noto'g'ri: ${String(this.port)}`,
      };
    }

    return new Promise<PrintSendResult>((resolve) => {
      const socket = new net.Socket();
      let settled = false;

      const finish = (result: PrintSendResult, destroySocket = true) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners();
        if (destroySocket && !socket.destroyed) {
          socket.destroy();
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({
          ok: false,
          mode: 'network_tcp',
          target: this.target,
          errorCode: 'PRINTER_TIMEOUT',
          errorMessage: `Tarmoq printeri javob bermadi (${String(this.timeoutMs)} ms timeout: ${this.target})`,
        });
      }, this.timeoutMs);

      socket.once('error', (err: NodeJS.ErrnoException) => {
        finish({
          ok: false,
          mode: 'network_tcp',
          target: this.target,
          errorCode: err.code ? `PRINTER_TCP_${err.code}` : 'PRINTER_TCP_ERROR',
          errorMessage: `Tarmoq printeriga ulanishda xato (${this.target}): ${err.message}`,
        });
      });

      socket.connect(this.port, this.host, () => {
        const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        socket.write(buffer, (writeErr) => {
          if (writeErr) {
            finish({
              ok: false,
              mode: 'network_tcp',
              target: this.target,
              errorCode: 'PRINTER_WRITE_ERROR',
              errorMessage: `Tarmoq printeriga yozishda xato (${this.target}): ${writeErr.message}`,
            });
            return;
          }
          socket.once('close', () => {
            finish(
              {
                ok: true,
                mode: 'network_tcp',
                target: this.target,
                bytesSent: buffer.byteLength,
              },
              false,
            );
          });
          socket.end();
        });
      });
    });
  }
}
