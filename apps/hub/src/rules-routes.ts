import {
  type ActiveRulesPackageResponseDto,
  ImportRulesPackageRequestSchema,
  type ImportRulesPackageResponseDto,
  RulesCheckRequestSchema,
  type RulesCheckResponseDto,
} from '@mezon/contracts';
import { type HubPermission, parseUuidV7 } from '@mezon/domain';
import { type RulesResult, rulesPayloadToWire } from '@mezon/rules';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { HubAuthService } from './auth-service.js';
import type { HubCartService } from './cart-service.js';
import type { HubRulesService } from './rules-service.js';

async function authorize(
  authService: HubAuthService,
  request: FastifyRequest,
  permission: HubPermission,
) {
  const session = await authService.authenticate(request.headers.authorization);
  authService.assertPermission(session, permission);
  return session;
}

const CartIdParamsSchema = z.strictObject({ id: z.string() });

function toCheckDto(res: RulesResult): RulesCheckResponseDto {
  return {
    block: res.block.map((f) => ({ ...f, lineIds: [...f.lineIds] })),
    warn: res.warn.map((f) => ({ ...f, lineIds: [...f.lineIds] })),
    packageVersion: res.packageVersion,
  };
}

/**
 * T3.2 rules routes:
 * - POST /rules/package          import a signed package (owner/manager, `rules:import`)
 * - GET  /rules/package/active   active package state + verified payload (any cashier)
 * - POST /carts/:id/rules-check  preview with the SAME `evaluate` as the final sale check
 */
export function registerRulesRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  rulesService: HubRulesService,
  cartService: HubCartService,
  nowMs: () => bigint,
): void {
  app.post('/rules/package', async (request): Promise<ImportRulesPackageResponseDto> => {
    const session = await authorize(authService, request, 'rules:import');
    const body = ImportRulesPackageRequestSchema.parse(request.body);
    const outcome = await rulesService.importPackage(body.envelope, session.user.id);
    request.log.info(
      {
        event: 'rules.package_imported',
        packageVersion: outcome.record.packageVersion.toString(),
        keyId: outcome.record.keyId,
        idempotentReplay: outcome.idempotentReplay,
      },
      'Rules package imported',
    );
    return {
      packageVersion: outcome.record.packageVersion.toString(),
      keyId: outcome.record.keyId,
      validUntilMs: outcome.record.validUntilMs.toString(),
      importedByUserId: outcome.record.importedByUserId,
      idempotentReplay: outcome.idempotentReplay,
    };
  });

  app.get('/rules/package/active', async (request): Promise<ActiveRulesPackageResponseDto> => {
    await authorize(authService, request, 'cart:write');
    const status = rulesService.loadStatusSync(nowMs());
    const pkg = status.package;
    return {
      state: status.state,
      fiscalMode: status.fiscalMode,
      packageVersion: pkg ? pkg.payload.packageVersion.toString() : null,
      keyId: pkg ? pkg.keyId : null,
      issuedAtMs: pkg ? pkg.payload.issuedAtMs.toString() : null,
      validUntilMs: pkg ? pkg.payload.validUntilMs.toString() : null,
      payload: pkg
        ? (rulesPayloadToWire(pkg.payload) as ActiveRulesPackageResponseDto['payload'])
        : null,
    };
  });

  app.post('/carts/:id/rules-check', async (request): Promise<RulesCheckResponseDto> => {
    await authorize(authService, request, 'cart:write');
    const params = CartIdParamsSchema.parse(request.params);
    const body = RulesCheckRequestSchema.parse(request.body ?? {});
    const { cart } = await cartService.getCart(parseUuidV7(params.id));
    const result = rulesService.preview(
      {
        lines: cart.lines.map((l) => ({
          lineId: l.id,
          lineKind: l.lineKind,
          mxik: l.mxikSnapshot,
          qtyMilli: BigInt(l.qty),
          finalTotalTiyin: BigInt(l.finalTotal),
          batchExpiries: [],
        })),
      },
      body.payments.map((p) =>
        p.method === 'cash'
          ? {
              method: 'cash',
              amountTiyin: BigInt(p.amount ?? p.tenderedAmount),
              socialCard: null,
            }
          : {
              method: p.method,
              amountTiyin: BigInt(p.amount),
              socialCard: p.socialCard ?? null,
            },
      ),
    );
    return toCheckDto(result);
  });
}
