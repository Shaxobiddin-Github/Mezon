import { parseUuidV7 } from '@mezon/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HubAuthService } from './auth-service.js';
import type { HubCartService } from './cart-service.js';
import type { HubMarkingService } from './marking-service.js';

const CartParams = z.strictObject({ id: z.string() });
const MarkParams = z.strictObject({ id: z.string(), markId: z.string() });
const ScanBody = z.strictObject({ code: z.string().min(1).max(512) });

/**
 * T3.7 marking codes on a cart (`cart:write`):
 * - POST   /carts/:id/marks          scan one code → its product line gets one more unit
 * - GET    /carts/:id/marks          codes in the cart
 * - DELETE /carts/:id/marks/:markId  remove one code (the line loses one unit)
 */
export function registerMarkingRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  service: HubMarkingService,
  cartService: HubCartService,
): void {
  const auth = async (authorization: string | undefined) => {
    const session = await authService.authenticate(authorization);
    authService.assertPermission(session, 'cart:write');
    return session;
  };

  app.post('/carts/:id/marks', async (request, reply) => {
    await auth(request.headers.authorization);
    const { id } = CartParams.parse(request.params);
    const { code } = ScanBody.parse(request.body);
    const res = await service.scan(parseUuidV7(id), code);
    return reply.code(201).send({
      ...(await cartService.getCart(parseUuidV7(id))),
      checkStatus: res.checkStatus,
      marks: service.listMarks(parseUuidV7(id)),
    });
  });

  app.get('/carts/:id/marks', async (request) => {
    await auth(request.headers.authorization);
    const { id } = CartParams.parse(request.params);
    return { marks: service.listMarks(parseUuidV7(id)) };
  });

  app.delete('/carts/:id/marks/:markId', async (request) => {
    await auth(request.headers.authorization);
    const { id, markId } = MarkParams.parse(request.params);
    await service.removeMark(parseUuidV7(id), parseUuidV7(markId));
    return {
      ...(await cartService.getCart(parseUuidV7(id))),
      marks: service.listMarks(parseUuidV7(id)),
    };
  });
}
