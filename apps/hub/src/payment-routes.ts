import { type HubPermission, parseUuidV7 } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { HubAuthService } from './auth-service.js';
import type { HubPaymentService } from './payment-service.js';

const IdParams = z.strictObject({ id: z.string() });
const CreateBody = z.strictObject({
  cartId: z.string().nullable().optional(),
  amount: z.string().regex(/^[0-9]+$/),
  kind: z.enum(['dynamic', 'static']).default('dynamic'),
});
const ConfirmBody = z.strictObject({ note: z.string().trim().min(3).max(300) });

/**
 * T3.6 UzQR payment intents:
 * - POST /payments/intents              create a QR (cashier, `cart:write`)
 * - GET  /payments/intents/:id          refresh from the provider (cashier)
 * - POST /payments/intents/:id/cancel   the customer pays another way (cashier)
 * - POST /payments/intents/:id/confirm  static QR, by hand (manager / owner, `payments:confirm`)
 * - POST /payments/intents/:id/refund   a paid, unused QR (manager / owner, `payments:confirm`)
 */
export function registerPaymentRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  service: HubPaymentService,
): void {
  const authorize = async (request: FastifyRequest, permission: HubPermission) => {
    const session = await authService.authenticate(request.headers.authorization);
    authService.assertPermission(session, permission);
    return session;
  };

  app.post('/payments/intents', async (request, reply) => {
    await authorize(request, 'cart:write');
    const body = CreateBody.parse(request.body);
    const intent = await service.create({
      cartId: body.cartId ? parseUuidV7(body.cartId) : null,
      amountTiyin: BigInt(body.amount),
      kind: body.kind,
    });
    return reply.code(201).send({ intent });
  });

  app.get('/payments/intents/:id', async (request) => {
    await authorize(request, 'cart:write');
    const { id } = IdParams.parse(request.params);
    return { intent: await service.refresh(parseUuidV7(id)) };
  });

  app.post('/payments/intents/:id/cancel', async (request) => {
    await authorize(request, 'cart:write');
    const { id } = IdParams.parse(request.params);
    return { intent: service.cancel(parseUuidV7(id)) };
  });

  app.post('/payments/intents/:id/confirm', async (request) => {
    const session = await authorize(request, 'payments:confirm');
    const { id } = IdParams.parse(request.params);
    const { note } = ConfirmBody.parse(request.body);
    return { intent: service.confirmStatic(parseUuidV7(id), session.user.id, note) };
  });

  app.post('/payments/intents/:id/refund', async (request) => {
    const session = await authorize(request, 'payments:confirm');
    const { id } = IdParams.parse(request.params);
    const intent = await service.refund(parseUuidV7(id));
    request.log.info(
      { event: 'payment.refunded', intentId: intent.id, userId: session.user.id },
      'QR payment refunded',
    );
    return { intent };
  });
}
