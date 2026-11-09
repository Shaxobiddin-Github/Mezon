import { DOMAIN_PACKAGE } from '@mezon/domain';

export const RULES_PACKAGE = '@mezon/rules';

export function isDomainAvailable(): boolean {
  return DOMAIN_PACKAGE.length > 0;
}
