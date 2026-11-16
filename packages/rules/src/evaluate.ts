import { allocate, moneyFromTiyin, moneyToTiyin } from '@mezon/domain';
import type {
  MxikMatchList,
  RuleCode,
  RuleFinding,
  RulesCartInput,
  RulesContext,
  RulesPaymentInput,
  RulesResult,
} from './types.js';

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

/** Exact match or prefix match against a signed MXIK list. */
export function matchesMxikList(mxik: string | null, list: MxikMatchList): boolean {
  if (mxik === null) return false;
  return list.exact.includes(mxik) || list.prefixes.some((p) => mxik.startsWith(p));
}

/**
 * Cash tendered as legal cash: only the `cash` method counts. `advance` (earlier deposit), debt and
 * all card/QR methods are not cash for these rules (owner answer S3: no cash-forbidden goods today;
 * advance/debt classification documented in the report as an assumption).
 */
function cashTiyin(payments: readonly RulesPaymentInput[]): bigint {
  return payments.reduce((acc, p) => (p.method === 'cash' ? acc + p.amountTiyin : acc), 0n);
}

/**
 * T3.2 rules evaluation — the single pure function used by the hub preview endpoint
 * (`/carts/:id/rules-check`, POS panel) and the final check inside `completeSaleCoreInTxSync`
 * (cart complete, order deliver).
 */
export function evaluate(
  cart: RulesCartInput,
  payments: readonly RulesPaymentInput[],
  context: RulesContext,
): RulesResult {
  const block: RuleFinding[] = [];
  const warn: RuleFinding[] = [];
  const pkg = context.pkgState === 'ok' || context.pkgState === 'expired' ? context.pkg : null;

  // §8 package state. missing/invalid: warn now, block in fiscal mode (S10). expired: warn and
  // keep applying the last verified rules.
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

  const cash = cashTiyin(payments);

  // CASH_FORBIDDEN_MXIK / MIXED_RECEIPT_CASHLESS — data-driven (empty list today, S3).
  // Any cash on a receipt with a forbidden MXIK blocks: whole receipt must be cashless.
  if (pkg !== null && cash > 0n) {
    const forbidden = cart.lines
      .filter((l) => matchesMxikList(l.mxik, pkg.payload.cashForbidden))
      .map((l) => l.lineId);
    if (forbidden.length > 0) {
      const code: RuleCode =
        forbidden.length === cart.lines.length ? 'CASH_FORBIDDEN_MXIK' : 'MIXED_RECEIPT_CASHLESS';
      block.push(finding(code, forbidden, { cashTiyin: cash.toString() }));
    }
  }

  // MXIK_CASH_LIMIT — per MXIK on ONE receipt; limit value and mode only from the package (S4).
  const limit = pkg?.payload.perMxikCashLimit ?? null;
  if (limit !== null && cash > 0n && cart.lines.length > 0) {
    const totals = cart.lines.map((l) => (l.finalTotalTiyin > 0n ? l.finalTotalTiyin : 0n));
    const receiptTotal = totals.reduce((a, b) => a + b, 0n);
    let attributed: readonly bigint[] = totals;
    if (limit.appliesTo === 'cash') {
      const cashApplied = cash < receiptTotal ? cash : receiptTotal;
      attributed =
        receiptTotal > 0n
          ? allocate(moneyFromTiyin(cashApplied), totals).map((m) => moneyToTiyin(m))
          : totals.map(() => 0n);
    }
    const groups = new Map<string, { amount: bigint; lineIds: string[] }>();
    cart.lines.forEach((l, i) => {
      if (l.mxik === null || matchesMxikList(l.mxik, limit.exempt)) return;
      const g = groups.get(l.mxik) ?? { amount: 0n, lineIds: [] };
      g.amount += attributed[i] ?? 0n;
      g.lineIds.push(l.lineId);
      groups.set(l.mxik, g);
    });
    for (const [mxik, g] of groups) {
      const over = limit.inclusive ? g.amount > limit.limitTiyin : g.amount >= limit.limitTiyin;
      if (over) {
        block.push(
          finding('MXIK_CASH_LIMIT', g.lineIds, {
            mxik,
            amountTiyin: g.amount.toString(),
            limitTiyin: limit.limitTiyin.toString(),
            appliesTo: limit.appliesTo,
          }),
        );
      }
    }
  }

  // EXPIRED_GOODS — WARN only (owner S7): expiring today has no finding; before today warns.
  // Package-independent (active without a package). Preview has no FIFO legs.
  if (pkg === null || pkg.payload.expiredGoods.enabled) {
    for (const line of cart.lines) {
      const expired = line.batchExpiries.filter(
        (b) => b.expiryDateMs !== null && context.toDateKey(b.expiryDateMs) < context.todayDateKey,
      );
      if (expired.length > 0) {
        const earliest = expired.map((b) => context.toDateKey(b.expiryDateMs ?? 0n)).sort()[0];
        warn.push(finding('EXPIRED_GOODS', [line.lineId], { expiryDate: earliest ?? '' }));
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
