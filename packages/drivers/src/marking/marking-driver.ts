/**
 * T3.7 marking (national "Asl belgisi" style) verification port. The real operator API is NOT
 * known yet (T3.0): no endpoint, field or signature is invented here — only the questions the
 * cash register must be able to ask, and a deterministic Fake.
 */
export interface MarkingCheckRequest {
  readonly gtin: string;
  readonly serial: string;
  /** Normalized GS1 element string (with the crypto tail) exactly as scanned. */
  readonly code: string;
  /** MXIK of the product being sold: the code must belong to a product with this MXIK. */
  readonly mxik: string | null;
}

export type MarkingCheckResult =
  | { readonly status: 'ok' }
  | { readonly status: 'mismatch'; readonly expectedMxik: string | null }
  | { readonly status: 'already_sold' }
  | { readonly status: 'unknown_code' };

/** Thrown when the operator cannot be reached: the caller decides (offline is a fallback). */
export class MarkingUnavailableError extends Error {
  constructor(message = 'Marking operator unavailable') {
    super(message);
    this.name = 'MarkingUnavailableError';
  }
}

export interface MarkingDriver {
  readonly driverId: string;
  readonly isTestDriver: boolean;
  check(request: MarkingCheckRequest): Promise<MarkingCheckResult>;
}

/**
 * Deterministic test driver. Knows a GTIN → MXIK table and a set of codes the "operator" already
 * saw sold; can be switched offline. Codes are matched by GTIN + serial.
 */
export class FakeMarkingDriver implements MarkingDriver {
  public readonly driverId = 'fake';
  public readonly isTestDriver = true;
  private online = true;
  private readonly soldKeys = new Set<string>();
  private calls = 0;

  /**
   * @param gtinMxik known GTIN → MXIK pairs (a GTIN listed with another MXIK is a mismatch)
   * @param strict unknown GTINs are `unknown_code` when true; accepted when false (default Fake)
   */
  constructor(
    private readonly gtinMxik: Readonly<Record<string, string>> = {},
    private readonly strict = false,
  ) {}

  setOnline(online: boolean): void {
    this.online = online;
  }

  markSold(gtin: string, serial: string): void {
    this.soldKeys.add(`${gtin}:${serial}`);
  }

  callCount(): number {
    return this.calls;
  }

  check(request: MarkingCheckRequest): Promise<MarkingCheckResult> {
    this.calls += 1;
    if (!this.online) return Promise.reject(new MarkingUnavailableError());
    const expected = this.gtinMxik[request.gtin];
    if (this.soldKeys.has(`${request.gtin}:${request.serial}`)) {
      return Promise.resolve({ status: 'already_sold' });
    }
    if (expected === undefined) {
      return Promise.resolve(this.strict ? { status: 'unknown_code' } : { status: 'ok' });
    }
    if (request.mxik !== null && request.mxik !== expected) {
      return Promise.resolve({ status: 'mismatch', expectedMxik: expected });
    }
    return Promise.resolve({ status: 'ok' });
  }
}
