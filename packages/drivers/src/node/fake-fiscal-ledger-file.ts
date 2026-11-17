import fs from 'node:fs';
import type { FakeFiscalLedger, FakeFiscalLedgerStore } from '../fiscal/fake-driver.js';

/**
 * File-backed `FakeFiscalDriver` ledger for crash tests: the "operator" keeps what it accepted even
 * when the hub process dies. Every write is fsync'ed before returning.
 */
export class FileFakeFiscalLedgerStore implements FakeFiscalLedgerStore {
  private readonly filePath: string;

  public constructor(filePath: string) {
    this.filePath = filePath;
  }

  public read(): FakeFiscalLedger {
    if (!fs.existsSync(this.filePath)) return { seq: 0, entries: {} };
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as FakeFiscalLedger;
  }

  public write(ledger: FakeFiscalLedger): void {
    const tmp = `${this.filePath}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(ledger));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.filePath);
  }
}
