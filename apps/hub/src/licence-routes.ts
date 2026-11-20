import type { FastifyInstance } from 'fastify';
import type { HubAuthService } from './auth-service.js';
import type { HubLicenceService, HubLicenceView } from './licence-service.js';

/** T4.7: licence state for the POS banner (any signed-in cashier). Never blocks sales. */
export function registerLicenceRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  licenceService: HubLicenceService,
): void {
  app.get('/licence/status', async (request): Promise<HubLicenceView> => {
    const session = await authService.authenticate(request.headers.authorization);
    authService.assertPermission(session, 'cart:write');
    return licenceService.getView();
  });
}
