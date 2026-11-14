import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { FakePrinterDriver, NullPrinterDriver } from '../../index.js';
import { NetworkPrinterDriver, WindowsRawPrinterDriver, type WinspoolBindings } from '../index.js';

describe('@mezon/drivers/node - NetworkPrinterDriver, WindowsRawPrinterDriver, Null & Fake Drivers', () => {
  it('NullPrinterDriver and FakePrinterDriver behave deterministically', async () => {
    const nullDriver = new NullPrinterDriver();
    const nullRes = await nullDriver.sendRaw(new Uint8Array([0x1b, 0x40]));
    expect(nullRes).toEqual({
      ok: true,
      mode: 'disabled',
      target: null,
      bytesSent: 0,
    });

    const fakeDriver = new FakePrinterDriver({ mode: 'network_tcp', target: '192.168.1.50:9100' });
    const payload = new Uint8Array([0x1b, 0x40, 0x41, 0x0a]);
    const okRes = await fakeDriver.sendRaw(payload, 'Test Job');
    expect(okRes).toEqual({
      ok: true,
      mode: 'network_tcp',
      target: '192.168.1.50:9100',
      bytesSent: 4,
    });
    expect(fakeDriver.getSentJobs().length).toBe(1);

    fakeDriver.setSimulateFailure({ errorCode: 'PAPER_OUT', errorMessage: 'Qogoz tugadi' });
    const failRes = await fakeDriver.sendRaw(payload);
    expect(failRes).toEqual({
      ok: false,
      mode: 'network_tcp',
      target: '192.168.1.50:9100',
      errorCode: 'PAPER_OUT',
      errorMessage: 'Qogoz tugadi',
    });
  });

  it('NetworkPrinterDriver sends exact bytes to a TCP 9100 server, rejects public hosts, and handles timeout/refused cleanly', async () => {
    // 1. Rejects non-local host (P2)
    const badHostDriver = new NetworkPrinterDriver({ host: '8.8.8.8', port: 9100 });
    const badHostRes = await badHostDriver.sendRaw(new Uint8Array([1, 2, 3]));
    expect(badHostRes.ok).toBe(false);
    if (!badHostRes.ok) {
      expect(badHostRes.errorCode).toBe('PRINTER_INVALID_HOST');
    }

    // 2. Successful TCP write to loopback server
    const receivedChunks: Buffer[] = [];
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        receivedChunks.push(Buffer.from(chunk));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as net.AddressInfo;

    try {
      const driver = new NetworkPrinterDriver({
        host: '127.0.0.1',
        port: address.port,
        timeoutMs: 2000,
      });
      const sampleBytes = new Uint8Array([0x1b, 0x40, 0x4d, 0x45, 0x5a, 0x4f, 0x4e, 0x0a]);
      const sendRes = await driver.sendRaw(sampleBytes);
      expect(sendRes).toEqual({
        ok: true,
        mode: 'network_tcp',
        target: `127.0.0.1:${String(address.port)}`,
        bytesSent: sampleBytes.length,
      });
      const merged = Buffer.concat(receivedChunks);
      expect(new Uint8Array(merged)).toEqual(sampleBytes);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // 3. Connection refused on closed port returns structured failure without throwing
    const refusedDriver = new NetworkPrinterDriver({
      host: '127.0.0.1',
      port: address.port,
      timeoutMs: 1000,
    });
    const refusedRes = await refusedDriver.sendRaw(new Uint8Array([0x1b, 0x40]));
    expect(refusedRes.ok).toBe(false);
  });

  it('WindowsRawPrinterDriver executes exact winspool.drv sequence and cleans up handles on both success and failure', async () => {
    const calls: string[] = [];
    const fakeHandle = { ptr: 101 };

    const successBindings: WinspoolBindings = {
      OpenPrinterW(printerName) {
        calls.push(`OpenPrinterW(${printerName})`);
        return { ok: true, handle: fakeHandle };
      },
      StartDocPrinterW(_handle, docTitle) {
        calls.push(`StartDocPrinterW(${docTitle})`);
        return 77;
      },
      StartPagePrinter() {
        calls.push('StartPagePrinter');
        return true;
      },
      WritePrinter(_handle, bytes) {
        calls.push(`WritePrinter(${String(bytes.byteLength)})`);
        return { ok: true, bytesWritten: bytes.byteLength };
      },
      EndPagePrinter() {
        calls.push('EndPagePrinter');
        return true;
      },
      EndDocPrinter() {
        calls.push('EndDocPrinter');
        return true;
      },
      ClosePrinter() {
        calls.push('ClosePrinter');
        return true;
      },
    };

    const driver = new WindowsRawPrinterDriver({
      printerName: 'XP-80C',
      bindings: successBindings,
      platform: 'win32',
    });
    const res = await driver.sendRaw(new Uint8Array([0x1b, 0x40, 0x31]), 'Receipt #1');
    expect(res).toEqual({
      ok: true,
      mode: 'windows_raw',
      target: 'XP-80C',
      bytesSent: 3,
    });
    expect(calls).toEqual([
      'OpenPrinterW(XP-80C)',
      'StartDocPrinterW(Receipt #1)',
      'StartPagePrinter',
      'WritePrinter(3)',
      'EndPagePrinter',
      'EndDocPrinter',
      'ClosePrinter',
    ]);

    // Partial write failure still calls EndPagePrinter, EndDocPrinter, ClosePrinter in finally
    const failCalls: string[] = [];
    const failBindings: WinspoolBindings = {
      ...successBindings,
      OpenPrinterW(printerName) {
        failCalls.push(`OpenPrinterW(${printerName})`);
        return { ok: true, handle: fakeHandle };
      },
      StartDocPrinterW() {
        failCalls.push('StartDocPrinterW');
        return 88;
      },
      StartPagePrinter() {
        failCalls.push('StartPagePrinter');
        return true;
      },
      WritePrinter() {
        failCalls.push('WritePrinter_FAIL');
        return { ok: false, bytesWritten: 1 };
      },
      EndPagePrinter() {
        failCalls.push('EndPagePrinter');
        return true;
      },
      EndDocPrinter() {
        failCalls.push('EndDocPrinter');
        return true;
      },
      ClosePrinter() {
        failCalls.push('ClosePrinter');
        return true;
      },
    };

    const failDriver = new WindowsRawPrinterDriver({
      printerName: 'XP-80C',
      bindings: failBindings,
      platform: 'win32',
    });
    const failRes = await failDriver.sendRaw(new Uint8Array([1, 2, 3, 4]));
    expect(failRes.ok).toBe(false);
    if (!failRes.ok) {
      expect(failRes.errorCode).toBe('PRINTER_WRITE_FAILED');
    }
    expect(failCalls).toEqual([
      'OpenPrinterW(XP-80C)',
      'StartDocPrinterW',
      'StartPagePrinter',
      'WritePrinter_FAIL',
      'EndPagePrinter',
      'EndDocPrinter',
      'ClosePrinter',
    ]);
  });
});
