import type { CloudLicenceStore } from '@mezon/db-cloud';
import type { UnixMs, UuidV7 } from '@mezon/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createRequireAdminAuth } from './admin-routes.js';
import type { CloudJwtService } from './jwt.js';
import { type CloudLicenceService, PlanLimitError } from './licence-service.js';

export interface LicenceRoutesOptions {
  readonly jwtService: CloudJwtService;
  readonly service: CloudLicenceService;
  readonly store: CloudLicenceStore;
  readonly clock: { nowMs(): UnixMs };
  /** Device authentication shared with the sync routes (returns null after replying 401/403). */
  readonly requireDevice: (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<{ organizationId: UuidV7 } | null>;
}

/** 402 body for a refused growth action (new store/device); sales are never refused. */
export function planLimitReply(reply: FastifyReply, err: PlanLimitError) {
  return reply.code(402).send({
    error: 'Payment Required',
    code: 'PLAN_LIMIT_REACHED',
    kind: err.kind,
    limit: err.limit,
    state: err.state,
  });
}

export async function registerLicenceRoutes(
  app: FastifyInstance,
  opts: LicenceRoutesOptions,
): Promise<void> {
  await Promise.resolve();
  const requireAdminAuth = createRequireAdminAuth(opts.jwtService);

  app.get('/api/v1/admin/licence', { preHandler: [requireAdminAuth] }, async (req, reply) => {
    const user = req.user!;
    const [status, usage, invoices] = await Promise.all([
      opts.service.getStatus(user.org, opts.clock.nowMs()),
      opts.service.getUsage(user.org),
      opts.store.listInvoices(user.org),
    ]);
    return reply.code(200).send({
      state: status.state,
      plan: status.plan,
      limits: status.limits,
      endsAtMs: status.endsAtMs?.toString() ?? null,
      daysLeft: status.daysLeft,
      invalidLicence: status.invalidLicence,
      usage,
      invoices: invoices.map((i) => ({
        period: i.period,
        plan: i.plan,
        amountTiyin: i.amountTiyin.toString(),
        status: i.status,
        paidAtMs: i.paidAtMs?.toString() ?? null,
      })),
    });
  });

  // The hub caches the signed envelopes and verifies them itself, so it knows its plan offline.
  app.get('/api/v1/devices/licence', async (req, reply) => {
    const device = await opts.requireDevice(req, reply);
    if (!device) return reply;
    const [licences, createdAt] = await Promise.all([
      opts.store.listLicences(device.organizationId),
      opts.store.getOrganizationCreatedAtMs(device.organizationId),
    ]);
    return reply.code(200).send({
      organizationCreatedAtMs: createdAt.toString(),
      envelopes: licences.map((l) => l.envelope),
    });
  });
}
