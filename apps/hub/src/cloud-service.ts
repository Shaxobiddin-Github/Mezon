import {
  type CloudPairDeviceRequestDto,
  type CloudPairDeviceResponseDto,
  type HubCloudStatusDto,
} from '@mezon/contracts';
import { type SqliteCloudStore } from '@mezon/db-local';
import { type Clock, DomainError, type IdGenerator, type UuidV7, parseUuidV7 } from '@mezon/domain';
import type { SafeStoragePort } from './safe-storage-port.js';

export interface HubCloudServiceOptions {
  readonly cloudStore: SqliteCloudStore;
  readonly safeStorage: SafeStoragePort;
  readonly getDeviceId: () => Promise<UuidV7> | UuidV7;
  readonly clock: Clock;
  readonly idGen: IdGenerator;
  readonly fetchFn?: typeof fetch;
}

export class HubCloudService {
  private readonly cloudStore: SqliteCloudStore;
  private readonly safeStorage: SafeStoragePort;
  private readonly getDeviceId: () => Promise<UuidV7> | UuidV7;
  private readonly clock: Clock;
  private readonly idGen: IdGenerator;
  private readonly fetchFn: typeof fetch;

  constructor(options: HubCloudServiceOptions) {
    this.cloudStore = options.cloudStore;
    this.safeStorage = options.safeStorage;
    this.getDeviceId = options.getDeviceId;
    this.clock = options.clock;
    this.idGen = options.idGen;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async getStatus(): Promise<HubCloudStatusDto> {
    const state = await this.cloudStore.getCloudState();
    return {
      status: state?.status ?? 'unpaired',
      cloudUrl: state?.cloudUrl ?? null,
      organizationId: state?.organizationId ?? null,
      storeId: state?.storeId ?? null,
      pairedAtMs: state?.pairedAtMs ? Number(state.pairedAtMs) : null,
      lastSyncAtMs: state?.lastSyncAtMs ? Number(state.lastSyncAtMs) : null,
    };
  }

  async pair(params: { readonly cloudUrl: string; readonly code: string }): Promise<{
    readonly success: true;
    readonly status: 'paired';
    readonly organizationName: string;
    readonly storeName: string;
  }> {
    const normalizedUrl = params.cloudUrl.trim().replace(/\/+$/, '');
    const normalizedCode = params.code.trim().toUpperCase();
    const deviceId = await this.getDeviceId();
    const platform =
      process.platform === 'win32'
        ? 'windows'
        : process.platform === 'android'
          ? 'android'
          : 'linux';

    const payload: CloudPairDeviceRequestDto = {
      code: normalizedCode,
      deviceId,
      platform,
      appVersion: '0.1.0',
    };

    let response: Response;
    try {
      response = await this.fetchFn(`${normalizedUrl}/api/v1/devices/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new DomainError(
        'NETWORK_ERROR',
        `Bulut serverga ulanib bo‘lmadi: ${(err as Error).message}`,
      );
    }

    if (!response.ok) {
      let errBody: { error?: string; message?: string; code?: string } = {};
      try {
        errBody = (await response.json()) as typeof errBody;
      } catch {
        // ignore json parse error
      }

      if (response.status === 409) {
        throw new DomainError(
          'PAIRING_ALREADY_USED',
          errBody.message ??
            'Ushbu juftlash kodi allaqachon ishlatilgan yoki qurilma boshqa tashkilotga ulangan',
        );
      }
      if (response.status === 404) {
        throw new DomainError(
          'PAIRING_CODE_NOT_FOUND',
          errBody.message ?? 'Juftlash kodi topilmadi',
        );
      }
      if (response.status === 429) {
        throw new DomainError(
          'RATE_LIMITED',
          'Juftlash urinishlari ko‘payib ketdi. Birozdan so‘ng qayta urinib ko‘ring',
        );
      }

      throw new DomainError(
        'PAIRING_FAILED',
        errBody.message ?? `Bulut server xatolik qaytardi (${response.status})`,
      );
    }

    const data = (await response.json()) as CloudPairDeviceResponseDto;
    const nowMs = this.clock.now();

    // D4: Encrypt device token via safeStorage port before writing to SQLite
    const encryptedBytes = await this.safeStorage.encryptString(data.deviceToken);
    const encryptedDeviceToken = encryptedBytes.toString('base64');

    await this.cloudStore.saveCloudState({
      status: 'paired',
      cloudUrl: normalizedUrl,
      organizationId: parseUuidV7(data.organizationId),
      organizationName: data.organizationName,
      storeId: parseUuidV7(data.storeId),
      storeName: data.storeName,
      encryptedDeviceToken,
      pairedAtMs: nowMs,
      nowMs,
      idGen: this.idGen,
    });

    return {
      success: true,
      status: 'paired',
      organizationName: data.organizationName,
      storeName: data.storeName,
    };
  }

  async unpair(): Promise<{ readonly success: true; readonly status: 'unpaired' }> {
    const nowMs = this.clock.now();
    await this.cloudStore.clearCloudState(nowMs);
    return { success: true, status: 'unpaired' };
  }

  async getDecryptedToken(): Promise<string | null> {
    const state = await this.cloudStore.getCloudState();
    if (!state || !state.encryptedDeviceToken || state.status !== 'paired') {
      return null;
    }

    const cipherBuffer = Buffer.from(state.encryptedDeviceToken, 'base64');
    return this.safeStorage.decryptString(cipherBuffer);
  }
}
