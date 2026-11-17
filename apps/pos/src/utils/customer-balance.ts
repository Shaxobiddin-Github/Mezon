import { t } from '@mezon/i18n';
import { formatTiyinToSom } from '@mezon/ui';

/**
 * P1/S6: a negative balance is a real overpayment (two stores took the same debt offline). It is the
 * customer's credit, shown as such — never as a red "-X" debt.
 */
export function customerBalanceLabel(balanceTiyin: string): string {
  const balance = BigInt(balanceTiyin);
  const som = (v: bigint) => `${formatTiyinToSom(v.toString())} ${t('common.currency')}`;
  return balance < 0n
    ? t('customer.overpaid', { amount: som(-balance) })
    : t('customer.balance', { amount: som(balance) });
}
