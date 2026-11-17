import { type FiscalStatusResponse, SetFiscalModeRequestSchema } from '@mezon/contracts';
import { type HubPermission, parseUuidV7 } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { HubAuthService } from './auth-service.js';
import { type HubFiscalService, toFiscalDocDto } from './fiscal-service.js';

async function authorize(
  authService: HubAuthService,
  request: FastifyRequest,
  permission: HubPermission,
) {
  const session = await authService.authenticate(request.headers.authorization);
  authService.assertPermission(session, permission);
  return session;
}

const IdParamsSchema = z.strictObject({ id: z.string() });

/**
 * T3.3 fiscal routes:
 * - GET  /fiscal/status            mode, counts, offline warning (any signed-in user: POS header)
 * - GET  /fiscal/docs              unsettled documents (manager/owner, `fiscal:read`)
 * - POST /fiscal/docs/:id/retry    re-queue a failed document (manager/owner, `fiscal:retry`)
 * - PUT  /fiscal/mode              enable/disable fiscal mode (owner only, `fiscal:mode`)
 * - GET  /sales/:id/fiscal         fiscal state of one sale (receipt screen)
 */
export function registerFiscalRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  fiscalService: HubFiscalService,
): void {
  app.get('/fiscal/status', async (request): Promise<FiscalStatusResponse> => {
    await authorize(authService, request, 'cart:write');
    return fiscalService.status();
  });

  app.get('/fiscal/docs', async (request) => {
    await authorize(authService, request, 'fiscal:read');
    return { docs: fiscalService.listUnsettled() };
  });

  app.post('/fiscal/docs/:id/retry', async (request) => {
    const session = await authorize(authService, request, 'fiscal:retry');
    const { id } = IdParamsSchema.parse(request.params);
    const doc = await fiscalService.retry(parseUuidV7(id));
    request.log.info(
      { event: 'fiscal.retry_requested', docId: doc.id, userId: session.user.id },
      'Fiscal document re-queued',
    );
    return { doc: toFiscalDocDto(doc) };
  });

  app.put('/fiscal/mode', async (request) => {
    const session = await authorize(authService, request, 'fiscal:mode');
    const body = SetFiscalModeRequestSchema.parse(request.body);
    const modeEnabled = await fiscalService.setMode(body.enabled, session.user.id);
    return { modeEnabled };
  });

  app.get('/sales/:id/fiscal', async (request) => {
    await authorize(authService, request, 'cart:write');
    const { id } = IdParamsSchema.parse(request.params);
    const doc = fiscalService.saleDoc(parseUuidV7(id));
    return {
      doc: doc === null ? null : toFiscalDocDto(doc),
      isTestDriver: fiscalService.driver.isTestDriver,
    };
  });
}
