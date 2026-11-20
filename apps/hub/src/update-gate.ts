import type { FastifyInstance } from 'fastify';

/**
 * T4.8 (ishchi2 review B1): while an update is being prepared (backup) and started, no NEW receipt
 * work may begin anywhere — the local POS or a LAN terminal. Closing the gate refuses starting a
 * cart, adding / changing lines and resuming a parked cart (`503 HUB_UPDATING`); finishing,
 * parking and reading keep working, so a receipt already in progress is never stuck.
 *
 * The gate re-opens by itself after `maxClosedMs`, so a desktop shell that dies half-way can never
 * leave the shop unable to sell.
 */
export class HubUpdateGate {
  private closedUntilMs: number | null = null;

  constructor(
    private readonly nowMs: () => number = () => Date.now(),
    private readonly maxClosedMs = 15 * 60_000,
  ) {}

  close(): void {
    this.closedUntilMs = this.nowMs() + this.maxClosedMs;
  }

  open(): void {
    this.closedUntilMs = null;
  }

  isClosed(): boolean {
    if (this.closedUntilMs === null) return false;
    if (this.nowMs() >= this.closedUntilMs) {
      this.closedUntilMs = null;
      return false;
    }
    return true;
  }
}

/** Requests that start or grow a receipt. Completing, parking, discounts on it and reads are not. */
export function startsReceiptWork(method: string, url: string): boolean {
  const path = url.split('?')[0] ?? '';
  if (method === 'POST' && path === '/carts') return true;
  // A new QR payment starts a customer payment (P2 × C2).
  if (method === 'POST' && path === '/payments/intents') return true;
  if (method === 'POST' && /^\/carts\/[^/]+\/(lines|resume|marks)(\/.*)?$/.test(path)) return true;
  if (method === 'PATCH' && /^\/carts\/[^/]+\/lines\/[^/]+$/.test(path)) return true;
  return false;
}

export function registerUpdateGate(app: FastifyInstance, gate: HubUpdateGate): void {
  app.addHook('onRequest', async (request, reply) => {
    if (gate.isClosed() && startsReceiptWork(request.method, request.url)) {
      await reply.code(503).send({
        error: {
          code: 'HUB_UPDATING',
          message: "Dastur yangilanmoqda. Bir necha daqiqadan keyin qayta urinib ko'ring.",
        },
      });
    }
  });
}
