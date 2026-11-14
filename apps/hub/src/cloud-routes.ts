import { HubPairCloudRequestSchema } from '@mezon/contracts';
import type { FastifyInstance } from 'fastify';
import type { HubAuthService } from './auth-service.js';
import type { HubCloudService } from './cloud-service.js';

export function registerCloudRoutes(
  app: FastifyInstance,
  cloudService: HubCloudService,
  authService?: HubAuthService,
): void {
  // GET /cloud/status (D5: no /api/v1 prefix)
  app.get('/cloud/status', async () => {
    return cloudService.getStatus();
  });

  // POST /cloud/pair
  app.post('/cloud/pair', async (request, reply) => {
    if (authService) {
      const session = await authService.authenticate(request.headers.authorization);
      authService.assertPermission(session, 'users:write');
    }

    const body = HubPairCloudRequestSchema.parse(request.body);
    const result = await cloudService.pair(body);
    return reply.code(200).send(result);
  });

  // POST /cloud/unpair
  app.post('/cloud/unpair', async (request, reply) => {
    if (authService) {
      const session = await authService.authenticate(request.headers.authorization);
      authService.assertPermission(session, 'users:write');
    }

    const result = await cloudService.unpair();
    return reply.code(200).send(result);
  });
}
