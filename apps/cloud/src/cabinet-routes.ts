import type { CloudCabinetStore } from '@mezon/db-cloud';
import { type UuidV7, parseUuidV7 } from '@mezon/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CabinetWriteError, type CloudCabinetService } from './cabinet-service.js';

const PriceBody = z.strictObject({
  /** New sale price in tiyin, decimal string. */
  newPrice: z.string().regex(/^(0|[1-9]\d{0,14})$/),
  reason: z.string().trim().max(200).optional(),
});

const STATUS: Record<CabinetWriteError['code'], number> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  REJECTED: 409,
};

/**
 * T2.7b cabinet writes (owner / manager). Bearer access token like every admin route; the role and
 * status are re-read from the database for each write.
 */
export function registerCabinetRoutes(
  app: FastifyInstance,
  o: {
    readonly requireAdminAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    readonly service: CloudCabinetService;
    readonly store: CloudCabinetStore;
  },
): void {
  const idParam = (raw: string): UuidV7 | null => {
    try {
      return parseUuidV7(raw);
    } catch {
      return null;
    }
  };

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/products/:id/price',
    { preHandler: [o.requireAdminAuth] },
    async (req, reply) => {
      const user = req.user!;
      const productId = idParam(req.params.id);
      const body = PriceBody.safeParse(req.body);
      if (productId === null || !body.success) {
        return reply.code(400).send({ error: 'Validation Error', code: 'VALIDATION_ERROR' });
      }
      try {
        const res = await o.service.changeProductPrice({
          organizationId: user.org,
          cloudUserId: user.sub,
          productId,
          newPriceTiyin: BigInt(body.data.newPrice),
          reason: body.data.reason && body.data.reason.length > 0 ? body.data.reason : null,
        });
        req.log.info(
          { event: 'cabinet.price_changed', productId, userId: user.sub, changed: res.changed },
          'Cabinet price change',
        );
        return await reply.code(200).send({
          productId,
          oldPrice: res.oldPrice,
          newPrice: body.data.newPrice,
          changed: res.changed,
        });
      } catch (err) {
        if (err instanceof CabinetWriteError) {
          return reply
            .code(STATUS[err.code])
            .send({ error: err.code, code: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/admin/products/:id/price-changes',
    { preHandler: [o.requireAdminAuth] },
    async (req, reply) => {
      const user = req.user!;
      const productId = idParam(req.params.id);
      if (productId === null) return reply.code(400).send({ error: 'Validation Error' });
      return reply.code(200).send({ changes: await o.store.listPriceChanges(user.org, productId) });
    },
  );
}
