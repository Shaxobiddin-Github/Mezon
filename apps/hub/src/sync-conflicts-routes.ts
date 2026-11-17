import {
  ResolveSyncConflictRequestSchema,
  type ResolveSyncConflictResponseDto,
  SyncConflictListQuerySchema,
  type SyncConflictListResponseDto,
  type SyncParkedListResponseDto,
} from '@mezon/contracts';
import { type HubPermission, parseUuidV7 } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { HubAuthService } from './auth-service.js';
import type { HubSyncBootstrap } from './sync-bootstrap.js';
import type { HubCloudParkedService } from './sync-cloud-parked.js';
import type { HubSyncConflictService } from './sync-conflicts-service.js';

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
 * T2.6 sync conflict routes (manager / owner):
 * - GET  /sync/conflicts?status=open|resolved  (`sync:read`)
 * - GET  /sync/parked                           (`sync:read`)
 * - POST /sync/conflicts/:id/resolve            (`sync:resolve`) — `retry` or `acknowledge` only;
 *   the body is strict, so no data can be edited through this API.
 */
export function registerSyncConflictRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  service: HubSyncConflictService,
  cloudParked?: HubCloudParkedService,
  bootstrap?: HubSyncBootstrap,
): void {
  if (bootstrap) {
    // T2.5: initial load from the cloud (resumable; the POS shows the state).
    app.get('/sync/bootstrap', async (request) => {
      await authorize(authService, request, 'sync:read');
      return bootstrap.status();
    });
    app.post('/sync/bootstrap', async (request) => {
      const session = await authorize(authService, request, 'sync:resolve');
      const result = await bootstrap.run();
      request.log.info(
        { event: 'sync.bootstrap_run', userId: session.user.id, ...result },
        'Bootstrap run',
      );
      return result;
    });
  }

  if (cloudParked) {
    // The cloud side of this hub's parked pushes (device token; own store only).
    app.get('/sync/cloud-parked', async (request) => {
      await authorize(authService, request, 'sync:read');
      return { parked: await cloudParked.list() };
    });
    app.post('/sync/cloud-parked/:id/resolve', async (request) => {
      const session = await authorize(authService, request, 'sync:resolve');
      const { id } = IdParamsSchema.parse(request.params);
      const body = ResolveSyncConflictRequestSchema.parse(request.body);
      const parked = await cloudParked.resolve({
        id: parseUuidV7(id),
        action: body.action,
        note: body.note && body.note.length > 0 ? body.note : null,
        userId: session.user.id,
      });
      request.log.info(
        {
          event: 'sync.cloud_parked_resolved',
          parkedId: parked.id,
          action: body.action,
          userId: session.user.id,
        },
        'Cloud parked event resolved',
      );
      return { parked };
    });
  }

  app.get('/sync/conflicts', async (request): Promise<SyncConflictListResponseDto> => {
    await authorize(authService, request, 'sync:read');
    const q = SyncConflictListQuerySchema.parse(request.query ?? {});
    return service.list(q.status);
  });

  app.get('/sync/parked', async (request): Promise<SyncParkedListResponseDto> => {
    await authorize(authService, request, 'sync:read');
    return service.listParked();
  });

  app.post(
    '/sync/conflicts/:id/resolve',
    async (request): Promise<ResolveSyncConflictResponseDto> => {
      const session = await authorize(authService, request, 'sync:resolve');
      const { id } = IdParamsSchema.parse(request.params);
      const body = ResolveSyncConflictRequestSchema.parse(request.body);
      const result = service.resolve({
        id: parseUuidV7(id),
        action: body.action,
        note: body.note && body.note.length > 0 ? body.note : null,
        userId: session.user.id,
      });
      request.log.info(
        {
          event: 'sync.conflict_resolved',
          conflictId: result.conflict.id,
          reason: result.conflict.reason,
          origin: result.conflict.origin,
          action: body.action,
          applied: result.applied,
          userId: session.user.id,
        },
        'Sync conflict resolved',
      );
      return result;
    },
  );
}
