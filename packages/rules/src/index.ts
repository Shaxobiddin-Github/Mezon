import { ZERO_MONEY, moneyToTiyin } from '@mezon/domain';

export const RULES_PACKAGE = '@mezon/rules';

export function isDomainAvailable(): boolean {
  return moneyToTiyin(ZERO_MONEY) === 0n;
}
