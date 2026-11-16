import {
  type OrganizationTaxProfileDto,
  type TaxProfileResponseDto,
  UpdateTaxProfileRequestSchema,
} from '@mezon/contracts';
import type { SqliteTaxSettingsStore, StoredTaxProfileRecord } from '@mezon/db-local';
import type { HubPermission } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HubAuthService } from './auth-service.js';

async function authorize(
  authService: HubAuthService,
  request: FastifyRequest,
  permission: HubPermission,
) {
  const session = await authService.authenticate(request.headers.authorization);
  authService.assertPermission(session, permission);
  return session;
}

function toTaxProfileDto(profile: StoredTaxProfileRecord): OrganizationTaxProfileDto {
  return {
    id: profile.id,
    organizationId: profile.organizationId,
    tin: profile.tin,
    legalName: profile.legalName,
    legalAddress: profile.legalAddress,
    isVatPayer: profile.isVatPayer,
    defaultVatRateBp: profile.defaultVatRateBp,
    updatedByUserId: profile.updatedByUserId,
    updatedAtMs: String(profile.updatedAtMs),
  };
}

/**
 * T3.1 organization tax requisites (STIR, legal name/address, VAT payer status).
 * Read and write are restricted to owner/manager (`tax:read` / `tax:write`); cashiers get 403.
 */
export function registerTaxSettingsRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  taxSettingsStore: SqliteTaxSettingsStore,
): void {
  app.get('/settings/tax', async (request): Promise<TaxProfileResponseDto> => {
    await authorize(authService, request, 'tax:read');
    const profile = await taxSettingsStore.getProfile();
    return { profile: profile === null ? null : toTaxProfileDto(profile) };
  });

  app.put('/settings/tax', async (request): Promise<TaxProfileResponseDto> => {
    const session = await authorize(authService, request, 'tax:write');
    const body = UpdateTaxProfileRequestSchema.parse(request.body);
    const profile = await taxSettingsStore.upsertProfile(body, session.user.id);
    return { profile: toTaxProfileDto(profile) };
  });
}
