import {
  type IntegrationsStatusResponse,
  SetDemoModeRequestSchema,
  SetMarkingPrefixesRequestSchema,
} from '@mezon/contracts';
import {
  type LocalSqliteConnection,
  appendAuditInTxSync,
  readDemoModeSync,
  readMarkingPrefixesSync,
  writeDemoModeSync,
  writeMarkingPrefixesSync,
} from '@mezon/db-local';
import { DomainError, type HubPermission, type UnixMs, type UuidV7 } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HubAuthService } from './auth-service.js';
import type { HubRulesService } from './rules-service.js';

export interface IntegrationDriverInfo {
  readonly driverId: string;
  readonly isTestDriver: boolean;
}

export interface DemoRoutesDeps {
  readonly connection: LocalSqliteConnection;
  readonly rulesService: HubRulesService;
  readonly drivers: {
    readonly fiscal: IntegrationDriverInfo;
    readonly payment: IntegrationDriverInfo;
    readonly marking: IntegrationDriverInfo;
  };
  readonly getOrganizationId: () => UuidV7 | null;
  readonly nowMs: () => UnixMs;
  readonly nextId: () => UuidV7;
}

/**
 * V2 "Ulanishlar holati" (integrations status) and the demo switch:
 * - GET /settings/integrations      every signed-in user (the kassa shows SINOV when demo is on)
 * - PUT /settings/demo              owner only (`fiscal:mode`), audit-logged
 * - PUT /settings/marking-prefixes  owner / manager (`tax:write`), audit-logged
 */
export function registerDemoRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  deps: DemoRoutesDeps,
): void {
  const sqlite = deps.connection.sqlite;
  const authorize = async (request: FastifyRequest, permission: HubPermission) => {
    const session = await authService.authenticate(request.headers.authorization);
    authService.assertPermission(session, permission);
    return session;
  };
  const audit = (
    eventType: 'settings.demo_mode_changed' | 'settings.marking_prefixes_changed',
    actorUserId: UuidV7,
    details: Readonly<Record<string, string | number | boolean | null>>,
  ) => {
    const orgId = deps.getOrganizationId();
    if (orgId === null)
      throw new DomainError('AUTH_UNAUTHORIZED', 'Hub setup has not been completed');
    appendAuditInTxSync(sqlite, {
      organizationId: orgId,
      eventType,
      actorUserId,
      entity: 'local_hub_config',
      entityId: orgId,
      details,
      nowMs: deps.nowMs(),
      nextId: deps.nextId,
    });
  };

  const status = (): IntegrationsStatusResponse => {
    const rules = deps.rulesService.loadStatusSync(BigInt(deps.nowMs()));
    return {
      demoMode: readDemoModeSync(sqlite),
      fiscal: { ...deps.drivers.fiscal, modeEnabled: rules.fiscalMode },
      payment: deps.drivers.payment,
      marking: { ...deps.drivers.marking, mxikPrefixes: [...readMarkingPrefixesSync(sqlite)] },
      rules: {
        state: rules.state,
        isDemoPackage: rules.package?.keyId === 'demo',
        packageVersion: rules.package ? rules.package.payload.packageVersion.toString() : null,
      },
    };
  };

  app.get('/settings/integrations', async (request) => {
    await authorize(request, 'cart:write');
    return status();
  });

  app.put('/settings/demo', async (request) => {
    const session = await authorize(request, 'fiscal:mode');
    const { enabled } = SetDemoModeRequestSchema.parse(request.body);
    sqlite.transaction(() => {
      writeDemoModeSync(sqlite, enabled);
      audit('settings.demo_mode_changed', session.user.id, { enabled });
    })();
    request.log.info(
      { event: 'settings.demo_mode_changed', enabled, userId: session.user.id },
      'Demo mode changed',
    );
    return status();
  });

  app.put('/settings/marking-prefixes', async (request) => {
    const session = await authorize(request, 'tax:write');
    const { prefixes } = SetMarkingPrefixesRequestSchema.parse(request.body);
    sqlite.transaction(() => {
      const saved = writeMarkingPrefixesSync(sqlite, prefixes);
      audit('settings.marking_prefixes_changed', session.user.id, { prefixes: saved.join(',') });
    })();
    return status();
  });
}
