import type {
  RuleCode,
  RuleFinding,
  RulesCartInput,
  RulesContext,
  RulesPaymentInput,
  RulesResult,
  SocialCardInput,
} from './types.js';

/** Length bounds for social-card fields (nazoratchi S6 interim: non-empty + length only). */
export const SOCIAL_CARD_LIMITS = {
  cardType: { min: 1, max: 64 },
  cardNumber: { min: 4, max: 32 },
  transactionId: { min: 1, max: 128 },
} as const;

function finding(
  code: RuleCode,
  lineIds: readonly string[] = [],
  details?: Readonly<Record<string, string>>,
): RuleFinding {
  return {
    code,
    i18nKey: `rules.${code}`,
    lineIds,
    ...(details !== undefined ? { details } : {}),
  };
}

/** True when every social-card field is present, trimmed non-empty and within bounds. */
export function isSocialCardComplete(card: SocialCardInput | null): boolean {
  if (card === null) return false;
  const ok = (v: string, b: { min: number; max: number }) => {
    const t = v.trim();
    return t.length >= b.min && t.length <= b.max;
  };
  return (
    ok(card.cardType, SOCIAL_CARD_LIMITS.cardType) &&
    ok(card.cardNumber, SOCIAL_CARD_LIMITS.cardNumber) &&
    ok(card.transactionId, SOCIAL_CARD_LIMITS.transactionId)
  );
}

/**
 * T3.2 rules evaluation — the single pure function used by the POS (preview), the hub preview
 * endpoint and the final check inside `completeSaleCoreInTxSync` (cart complete, order deliver).
 *
 * T3.2a implements: package state (§8), EXPIRED_GOODS, SOCIAL_CARD_DATA_REQUIRED, MXIK_MISSING.
 * T3.2b codes (cash ban, mixed receipt, per-MXIK limit, prescription) are reserved and intentionally
 * NOT evaluated until the owner answers S1, S3–S5, S7, S8.
 */
export function evaluate(
  cart: RulesCartInput,
  payments: readonly RulesPaymentInput[],
  context: RulesContext,
): RulesResult {
  const block: RuleFinding[] = [];
  const warn: RuleFinding[] = [];
  const pkg = context.pkgState === 'ok' || context.pkgState === 'expired' ? context.pkg : null;

  // §8 package state. missing/invalid: warn now, block in fiscal mode (S10). expired: warn.
  if (context.pkgState === 'missing' || context.pkgState === 'invalid') {
    const f = finding(context.pkgState === 'missing' ? 'PACKAGE_MISSING' : 'PACKAGE_INVALID');
    (context.fiscalMode ? block : warn).push(f);
  } else if (context.pkgState === 'expired') {
    warn.push(
      finding('PACKAGE_EXPIRED', [], {
        validUntilMs: pkg?.payload.validUntilMs.toString() ?? '',
      }),
    );
  }

  // SOCIAL_CARD_DATA_REQUIRED — package-independent (active without a package).
  if (pkg === null || pkg.payload.socialCard.enabled) {
    payments.forEach((p, index) => {
      if (p.method === 'social_card' && !isSocialCardComplete(p.socialCard)) {
        block.push(finding('SOCIAL_CARD_DATA_REQUIRED', [], { paymentIndex: String(index) }));
      }
    });
  }

  // EXPIRED_GOODS — package-independent. A batch whose store-local expiry DATE is before today
  // blocks; expiring today is allowed (interim until owner answer S7). Preview has no FIFO legs.
  if (pkg === null || pkg.payload.expiredGoods.enabled) {
    for (const line of cart.lines) {
      const expired = line.batchExpiries.filter(
        (b) => b.expiryDateMs !== null && context.toDateKey(b.expiryDateMs) < context.todayDateKey,
      );
      if (expired.length > 0) {
        const earliest = expired.map((b) => context.toDateKey(b.expiryDateMs ?? 0n)).sort()[0];
        block.push(finding('EXPIRED_GOODS', [line.lineId], { expiryDate: earliest ?? '' }));
      }
    }
  }

  // MXIK_MISSING — informational (T3.1); fiscal behaviour belongs to T3.3.
  const missing = cart.lines.filter((l) => l.mxik === null).map((l) => l.lineId);
  if (missing.length > 0) {
    warn.push(finding('MXIK_MISSING', missing));
  }

  return {
    block,
    warn,
    packageVersion: pkg === null ? null : pkg.payload.packageVersion.toString(),
  };
}
