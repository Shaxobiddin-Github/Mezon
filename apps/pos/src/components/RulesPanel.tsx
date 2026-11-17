import type { RulesCheckResponseDto, SalePaymentInputDto } from '@mezon/contracts';
import { type I18nKey, t } from '@mezon/i18n';
import { useEffect, useState } from 'react';
import type { HubApiClient } from '../api/hub-client.js';

function findingText(code: string): string {
  const key = `rules.${code}` as I18nKey;
  try {
    return t(key);
  } catch {
    return code;
  }
}

/**
 * T3.2 rules panel: asks the hub (`POST /carts/:id/rules-check`, the SAME `evaluate` used by the
 * final sale check) whenever the cart or payments change and reports whether the sale is blocked.
 * The hub still enforces the final decision; this panel only disables "Yakunlash" and explains why.
 */
export function RulesPanel(props: {
  readonly api: HubApiClient;
  readonly cartId: string;
  readonly cartVersionKey: string;
  readonly payments: readonly SalePaymentInputDto[];
  readonly onBlockedChange: (blocked: boolean) => void;
}) {
  const { api, cartId, cartVersionKey, payments, onBlockedChange } = props;
  const [result, setResult] = useState<RulesCheckResponseDto | null>(null);
  const paymentsKey = JSON.stringify(payments);

  useEffect(() => {
    let cancelled = false;
    const parsedPayments = JSON.parse(paymentsKey) as SalePaymentInputDto[];
    const timer = window.setTimeout(() => {
      api
        .rulesCheck(cartId, { payments: parsedPayments })
        .then((res) => {
          if (cancelled) return;
          setResult(res);
          onBlockedChange(res.block.length > 0);
        })
        .catch(() => {
          // Preview failure never blocks locally; the hub's final check still applies.
          if (!cancelled) onBlockedChange(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, cartId, cartVersionKey, paymentsKey, onBlockedChange]);

  if (result === null || (result.block.length === 0 && result.warn.length === 0)) {
    return null;
  }
  return (
    <div className="pos-pane" data-testid="rules-panel">
      {result.block.map((f, i) => (
        <div
          key={`b-${String(i)}`}
          className="pos-error-banner"
          role="alert"
          data-testid={`rules-block-${f.code}`}
        >
          {findingText(f.code)}
        </div>
      ))}
      {result.warn.map((f, i) => (
        <div
          key={`w-${String(i)}`}
          className="pos-warning-banner"
          role="status"
          data-testid={`rules-warn-${f.code}`}
        >
          {findingText(f.code)}
        </div>
      ))}
    </div>
  );
}
