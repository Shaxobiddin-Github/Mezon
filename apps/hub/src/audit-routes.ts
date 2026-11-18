import { type LocalSqliteConnection, verifyAuditChainSync } from '@mezon/db-local';
import { DomainError, type UuidV7 } from '@mezon/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HubAuthService } from './auth-service.js';

const ListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * T3.8 audit journal (owner only, `audit:read`):
 * - GET /audit?limit=N   newest entries (no secrets are ever written into it)
 * - GET /audit/verify    walks the hash chain and names the first broken row
 */
export function registerAuditRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  connection: LocalSqliteConnection,
  getOrganizationId: () => UuidV7 | null,
): void {
  const org = () => {
    const o = getOrganizationId();
    if (o === null) throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not been completed');
    return o;
  };
  const auth = async (authorization: string | undefined) => {
    const session = await authService.authenticate(authorization);
    authService.assertPermission(session, 'audit:read');
    return session;
  };

  app.get('/audit', async (request) => {
    await auth(request.headers.authorization);
    const q = ListQuerySchema.parse(request.query ?? {});
    const rows = connection.sqlite
      .prepare(
        `SELECT seq, event_type, actor_user_id, entity, entity_id, details_json, hash, created_at_ms
           FROM local_audit_log WHERE organization_id = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(org(), q.limit) as {
      seq: bigint | number;
      event_type: string;
      actor_user_id: string | null;
      entity: string;
      entity_id: string | null;
      details_json: string;
      hash: string;
      created_at_ms: bigint | number;
    }[];
    return {
      entries: rows.map((r) => ({
        seq: String(r.seq),
        eventType: r.event_type,
        actorUserId: r.actor_user_id,
        entity: r.entity,
        entityId: r.entity_id,
        details: Object.fromEntries(JSON.parse(r.details_json) as [string, unknown][]),
        hash: r.hash,
        createdAtMs: String(r.created_at_ms),
      })),
    };
  });

  app.get('/audit/verify', async (request) => {
    const session = await auth(request.headers.authorization);
    const result = verifyAuditChainSync(connection.sqlite, org());
    request.log.info(
      { event: 'audit.verified', ok: result.ok, checked: result.checked, userId: session.user.id },
      'Audit chain verified',
    );
    return result;
  });
}
