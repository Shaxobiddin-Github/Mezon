import { randomBytes } from 'node:crypto';
import { type UuidV7, encodeUuidV7, unixMsFromBigInt } from '@mezon/domain';
import type { ExcelImportParsedRow } from './excel-port.js';

export interface StoredImportPreview {
  readonly token: UuidV7;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly items: readonly ExcelImportParsedRow[];
}

export class CatalogImportCache {
  private static readonly TTL_MS = 15 * 60 * 1000; // 15 minutes
  private readonly store = new Map<string, StoredImportPreview>();

  public savePreview(items: readonly ExcelImportParsedRow[]): UuidV7 {
    this.cleanExpired();
    const token = encodeUuidV7(unixMsFromBigInt(BigInt(Date.now())), randomBytes(10));
    const now = Date.now();
    this.store.set(token, {
      token,
      createdAtMs: now,
      expiresAtMs: now + CatalogImportCache.TTL_MS,
      items,
    });
    return token;
  }

  public getPreview(token: string): readonly ExcelImportParsedRow[] | null {
    this.cleanExpired();
    const entry = this.store.get(token);
    if (!entry) return null;
    if (Date.now() > entry.expiresAtMs) {
      this.store.delete(token);
      return null;
    }
    return entry.items;
  }

  public deletePreview(token: string): void {
    this.store.delete(token);
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [token, entry] of this.store.entries()) {
      if (now > entry.expiresAtMs) {
        this.store.delete(token);
      }
    }
  }
}
