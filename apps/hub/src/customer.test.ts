import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  ApiErrorEnvelopeSchema,
  ArchiveCustomerResponseSchema,
  CartResponseSchema,
  CompleteSaleResponseSchema,
  CreateReturnResponseSchema,
  CustomerDetailResponseSchema,
  CustomerLedgerMutationResponseSchema,
  CustomerLedgerResponseSchema,
  CustomerListResponseSchema,
  CustomerMutationResponseSchema,
  LoginResponseSchema,
  ProductDetailResponseSchema,
  VoidSaleResponseSchema,
} from '@mezon/contracts';
import { type PinHasher } from '@mezon/domain';
import { PII_LOG_REDACT_KEYS } from '@mezon/drivers/node';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubLogger, createHubServer } from './index.js';

const tempDirs: string[] = [];
const TEST_PORT = 47839;
const HOST_HEADER = `127.0.0.1:${TEST_PORT}`;

// 2026-06-15 10:00:00+05:00 (05:00:00Z)
const DAY1_1000_UTC_MS = BigInt(Date.parse('2026-06-15T05:00:00.000Z'));

function makeDbPath(name = 'hub-customer.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-customer-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

function makeFastTestHasher(): PinHasher {
  return {
    hash: (pin) => Promise.resolve(`fast-stub-hash:${pin}`),
    verify: (storedHash, pin) => Promise.resolve(storedHash === `fast-stub-hash:${pin}`),
  };
}

function authHeaders(token: string): Record<string, string> {
  return {
    host: HOST_HEADER,
    authorization: `Bearer ${token}`,
  };
}

function hostHeaders(): Record<string, string> {
  return { host: HOST_HEADER };
}

function collectJsonKeysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonKeysDeep(item, out);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectJsonKeysDeep(v, out);
    }
  }
  return out;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  }
});

describe('@mezon/hub - T1.7 Customers, Ledger, FIFO Overdue, RBAC & PII-Free Audit', () => {
  it('enforces HTTP RBAC, creditOverride supervisor PIN + lockout, E.164/UZ phones, FIFO overdue, return/void & zero-PII logs', async () => {
    const logLines: string[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        callback();
      },
    });

    const clock = new FixedClock(DAY1_1000_UTC_MS);
    const hub = await createHubServer({
      dbPath: makeDbPath(),
      port: TEST_PORT,
      clock,
      random: new SeededRandomSource(77),
      pinHasher: makeFastTestHasher(),
      logLevel: 'info',
      logStream,
    });

    const ownerPin = '849201';
    const mgrPin = '592817';
    const mgrLockPin = '618394';
    const cashierPin = '374829';

    try {
      // 1. Setup + create owner, manager, lock-test manager, cashier
      const setupRes = await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: hostHeaders(),
        payload: { owner: { fullName: 'Owner', username: 'owner17', pin: ownerPin } },
      });
      expect(setupRes.statusCode).toBe(201);

      const loginAs = async (username: string, pin: string) =>
        LoginResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'POST',
              url: '/auth/login',
              headers: hostHeaders(),
              payload: { username, pin },
            })
          ).json(),
        );

      let ownerLogin = await loginAs('owner17', ownerPin);
      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerLogin.token),
        payload: { fullName: 'Manager', username: 'mgr17', role: 'manager', pin: mgrPin },
      });
      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerLogin.token),
        payload: {
          fullName: 'Manager Lock',
          username: 'mgrlock',
          role: 'manager',
          pin: mgrLockPin,
        },
      });
      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerLogin.token),
        payload: { fullName: 'Cashier', username: 'cash17', role: 'cashier', pin: cashierPin },
      });

      let mgrLogin = await loginAs('mgr17', mgrPin);
      let cashLogin = await loginAs('cash17', cashierPin);

      // Seed catalog + stock
      const prodRes = await hub.app.inject({
        method: 'POST',
        url: '/products',
        headers: authHeaders(ownerLogin.token),
        payload: {
          name: 'Guruch',
          unit: 'kg',
          salePrice: '50000',
          vatRateBp: 0,
        },
      });
      expect(prodRes.statusCode).toBe(201);
      const product = ProductDetailResponseSchema.parse(prodRes.json()).product;

      const inRes = await hub.app.inject({
        method: 'POST',
        url: '/stock/moves/in',
        headers: authHeaders(ownerLogin.token),
        payload: {
          productId: product.id,
          reason: 'purchase',
          qty: '50000',
          totalCostValue: '1500000',
        },
      });
      expect(inRes.statusCode).toBe(201);

      // 2. Unauthenticated rejected -> 401
      const unauthRes = await hub.app.inject({
        method: 'GET',
        url: '/customers',
        headers: hostHeaders(),
      });
      expect(unauthRes.statusCode).toBe(401);

      // 3. Cashier can create basic profile (local UZ & international E.164), cannot set creditLimit/defaultDueDays
      const forbiddenCreate = await hub.app.inject({
        method: 'POST',
        url: '/customers',
        headers: authHeaders(cashLogin.token),
        payload: {
          fullName: 'Forbidden Credit Limit',
          creditLimit: '100000',
        },
      });
      expect(forbiddenCreate.statusCode).toBe(403);
      expect(ApiErrorEnvelopeSchema.parse(forbiddenCreate.json()).error.code).toBe(
        'AUTH_FORBIDDEN',
      );

      const cashCreate = await hub.app.inject({
        method: 'POST',
        url: '/customers',
        headers: authHeaders(cashLogin.token),
        payload: {
          fullName: 'SecretMijoz Ali',
          phone: '90 123-45-67',
          note: 'Doimiy xaridor',
        },
      });
      expect(cashCreate.statusCode).toBe(201);
      const cust1 = CustomerMutationResponseSchema.parse(cashCreate.json()).customer;
      expect(cust1.phoneNormalized).toBe('+998901234567');

      // International E.164 phone also accepted cleanly
      const e164Create = await hub.app.inject({
        method: 'POST',
        url: '/customers',
        headers: authHeaders(cashLogin.token),
        payload: {
          fullName: 'International E164 Mijoz',
          phone: '+7 999 555-44-33',
        },
      });
      expect(e164Create.statusCode).toBe(201);
      const cust2 = CustomerMutationResponseSchema.parse(e164Create.json()).customer;
      expect(cust2.phoneNormalized).toBe('+79995554433');

      // Invalid phone Zod error and duplicate phone DomainError must NOT leak phone digits
      const badPhoneRes = await hub.app.inject({
        method: 'POST',
        url: '/customers',
        headers: authHeaders(cashLogin.token),
        payload: {
          fullName: 'Invalid Phone',
          phone: '+000999888777',
        },
      });
      expect(badPhoneRes.statusCode).toBe(400);
      expect(badPhoneRes.body).not.toContain('000999888777');

      const dupPhoneRes = await hub.app.inject({
        method: 'POST',
        url: '/customers',
        headers: authHeaders(cashLogin.token),
        payload: {
          fullName: 'Dup Phone',
          phone: '+998901234567',
        },
      });
      expect(dupPhoneRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(dupPhoneRes.json()).error.code).toBe(
        'CUSTOMER_PHONE_ALREADY_EXISTS',
      );
      expect(dupPhoneRes.body).not.toContain('901234567');

      // Cashier cannot PATCH creditLimit (even to null), defaultDueDays, or isActive, cannot DELETE
      const cashPatchPolicy = await hub.app.inject({
        method: 'PATCH',
        url: `/customers/${cust1.id}`,
        headers: authHeaders(cashLogin.token),
        payload: { creditLimit: null },
      });
      expect(cashPatchPolicy.statusCode).toBe(403);

      const cashDelete = await hub.app.inject({
        method: 'DELETE',
        url: `/customers/${cust1.id}`,
        headers: authHeaders(cashLogin.token),
      });
      expect(cashDelete.statusCode).toBe(403);

      // Cashier cannot record opening-balance or adjustments
      const cashOpening = await hub.app.inject({
        method: 'POST',
        url: `/customers/${cust1.id}/opening-balance`,
        headers: authHeaders(cashLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000001',
          amount: '10000',
          reason: 'Opening',
        },
      });
      expect(cashOpening.statusCode).toBe(403);

      const cashAdj = await hub.app.inject({
        method: 'POST',
        url: `/customers/${cust1.id}/adjustments`,
        headers: authHeaders(cashLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000002',
          amountDelta: '10000',
          reason: 'Adj',
        },
      });
      expect(cashAdj.statusCode).toBe(403);

      // 4. Manager sets creditLimit = 100_000 & defaultDueDays = 3, plus opening balance 10_000
      const mgrPatch = await hub.app.inject({
        method: 'PATCH',
        url: `/customers/${cust1.id}`,
        headers: authHeaders(mgrLogin.token),
        payload: { creditLimit: '100000', defaultDueDays: 3 },
      });
      expect(mgrPatch.statusCode).toBe(200);

      const openBalRes = await hub.app.inject({
        method: 'POST',
        url: `/customers/${cust1.id}/opening-balance`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000003',
          amount: '10000',
          reason: 'Eski daftardagi qoldiq',
          dueDays: 3,
        },
      });
      expect(openBalRes.statusCode).toBe(201);
      const openBalDto = CustomerLedgerMutationResponseSchema.parse(openBalRes.json());
      expect(openBalDto.customer.balance).toBe('10000');

      // Second distinct opening-balance -> 409 OPENING_BALANCE_ALREADY_EXISTS
      const dupOpeningRes = await hub.app.inject({
        method: 'POST',
        url: `/customers/${cust1.id}/opening-balance`,
        headers: authHeaders(ownerLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000004',
          amount: '5000',
          reason: 'Ikkinchi boshlangich',
        },
      });
      expect(dupOpeningRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(dupOpeningRes.json()).error.code).toBe(
        'OPENING_BALANCE_ALREADY_EXISTS',
      );

      // 5. Credit sale exceeding limit (10_000 + 120_000 > 100_000) -> 409; creditOverride RBAC + lockout + approval
      const openCart = async (token: string) =>
        CartResponseSchema.parse(
          (
            await hub.app.inject({
              method: 'POST',
              url: '/carts',
              headers: authHeaders(token),
              payload: {},
            })
          ).json(),
        ).cart.id;

      const cart1 = await openCart(cashLogin.token);
      await hub.app.inject({
        method: 'POST',
        url: `/carts/${cart1}/lines`,
        headers: authHeaders(cashLogin.token),
        payload: { kind: 'catalog', productId: product.id, variantId: null, qty: '3000' }, // 150_000
      });

      const saleBlockedRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cart1}/complete`,
        headers: authHeaders(cashLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000010',
          expectedTotal: '150000',
          customerId: cust1.id,
          debtAmount: '120000',
          payments: [{ method: 'cash', tenderedAmount: '30000' }],
        },
      });
      expect(saleBlockedRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(saleBlockedRes.json()).error.code).toBe(
        'CREDIT_LIMIT_EXCEEDED',
      );

      // Cashier PIN rejected as creditOverride (403)
      const cashOverrideRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cart1}/complete`,
        headers: authHeaders(cashLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000011',
          expectedTotal: '150000',
          customerId: cust1.id,
          debtAmount: '120000',
          creditOverride: { username: 'cash17', pin: cashierPin },
          payments: [{ method: 'cash', tenderedAmount: '30000' }],
        },
      });
      expect(cashOverrideRes.statusCode).toBe(403);

      // 5 failed supervisor PINs trigger T0.6 lockout (401 x5 -> 6th call even with valid PIN is 429 AUTH_RATE_LIMITED)
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const failRes = await hub.app.inject({
          method: 'POST',
          url: `/carts/${cart1}/complete`,
          headers: authHeaders(cashLogin.token),
          payload: {
            clientRequestId: `01950000-0000-7000-8000-17000000002${attempt}`,
            expectedTotal: '150000',
            customerId: cust1.id,
            debtAmount: '120000',
            creditOverride: { username: 'mgrlock', pin: '000000' },
            payments: [{ method: 'cash', tenderedAmount: '30000' }],
          },
        });
        expect(failRes.statusCode).toBe(401);
      }

      const lockedOutRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cart1}/complete`,
        headers: authHeaders(cashLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000029',
          expectedTotal: '150000',
          customerId: cust1.id,
          debtAmount: '120000',
          creditOverride: { username: 'mgrlock', pin: mgrLockPin },
          payments: [{ method: 'cash', tenderedAmount: '30000' }],
        },
      });
      expect(lockedOutRes.statusCode).toBe(429);
      expect(ApiErrorEnvelopeSchema.parse(lockedOutRes.json()).error.code).toBe(
        'AUTH_RATE_LIMITED',
      );

      // Valid manager creditOverride succeeds
      const saleOkRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cart1}/complete`,
        headers: authHeaders(cashLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000030',
          expectedTotal: '150000',
          customerId: cust1.id,
          debtAmount: '120000',
          creditOverride: { username: 'mgr17', pin: mgrPin },
          payments: [{ method: 'cash', tenderedAmount: '30000' }],
        },
      });
      expect(saleOkRes.statusCode).toBe(200);
      const sale1Dto = CompleteSaleResponseSchema.parse(saleOkRes.json()).sale;
      expect(sale1Dto.debtAmount).toBe('120000');
      expect(sale1Dto.customerId).toBe(cust1.id);

      // 6. Advance clock 5 days (re-authenticate sessions on Day 6) -> customer becomes overdue in Asia/Tashkent -> GET /customers/overdue & GET /customers/:id
      clock.advance(5n * 86_400_000n);
      ownerLogin = await loginAs('owner17', ownerPin);
      mgrLogin = await loginAs('mgr17', mgrPin);
      cashLogin = await loginAs('cash17', cashierPin);
      const overdueRes = await hub.app.inject({
        method: 'GET',
        url: '/customers/overdue',
        headers: authHeaders(cashLogin.token),
      });
      expect(overdueRes.statusCode).toBe(200);
      const overdueDto = CustomerListResponseSchema.parse(overdueRes.json());
      expect(overdueDto.total).toBe(1);
      expect(overdueDto.items[0]?.id).toBe(cust1.id);
      expect(overdueDto.items[0]?.balance).toBe('130000');
      expect(overdueDto.items[0]?.overdueAmount).toBe('130000');
      expect(overdueDto.items[0]?.oldestOverdueDays).toBe(2);

      // Search by phone digits works via GET /customers?q=...
      const searchRes = await hub.app.inject({
        method: 'GET',
        url: '/customers?q=9012345',
        headers: authHeaders(cashLogin.token),
      });
      expect(searchRes.statusCode).toBe(200);
      expect(CustomerListResponseSchema.parse(searchRes.json()).items[0]?.id).toBe(cust1.id);

      // 7. Debt payments (D1 no overpayment + cash creates cashMove + card does not + FIFO clears opening_balance 10k + 40k of sale1)
      const overpayRes = await hub.app.inject({
        method: 'POST',
        url: `/customers/${cust1.id}/payments`,
        headers: authHeaders(cashLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000040',
          method: 'cash',
          amount: '130001',
        },
      });
      expect(overpayRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(overpayRes.json()).error.code).toBe(
        'OVERPAYMENT_NOT_ALLOWED',
      );

      const cashPayRes = await hub.app.inject({
        method: 'POST',
        url: `/customers/${cust1.id}/payments`,
        headers: authHeaders(cashLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000041',
          method: 'cash',
          amount: '50000',
          reason: 'Naqd qarz tolov',
        },
      });
      expect(cashPayRes.statusCode).toBe(201);
      const cashPayDto = CustomerLedgerMutationResponseSchema.parse(cashPayRes.json());
      expect(cashPayDto.cashMove?.type).toBe('debt_payment_in');
      expect(cashPayDto.cashMove?.amountDelta).toBe('50000');
      expect(cashPayDto.customer.balance).toBe('80000');

      // Partial return with debtOffsetAmount = 50_000 reduces sale1 debt from 80_000 -> 30_000
      const lineId = sale1Dto.lines[0]?.id;
      expect(lineId).toBeDefined();
      const retRes = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale1Dto.id}/returns`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000050',
          reason: 'Qisman qaytarish qarzdan ayirish',
          items: [{ saleLineId: lineId, qty: '1000' }],
          debtOffsetAmount: '50000',
          payments: [],
        },
      });
      expect(retRes.statusCode).toBe(201);
      expect(CreateReturnResponseSchema.parse(retRes.json()).returnDoc.debtOffsetAmount).toBe(
        '50000',
      );

      // Attempting void on paid debt sale rejects with 409 SALE_DEBT_HAS_PAYMENTS
      const voidPaidRes = await hub.app.inject({
        method: 'POST',
        url: `/sales/${sale1Dto.id}/void`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000051',
          reason: 'Void attempt',
        },
      });
      // Either VOID_WINDOW_EXPIRED (due to +5 days) or SALE_DEBT_HAS_PAYMENTS if same day -> let's test same-day void guard right below!
      expect(voidPaidRes.statusCode).toBe(409);

      // Negative adjustment waives remaining 30_000 -> balance becomes 0 -> archive succeeds
      const archiveBlocked = await hub.app.inject({
        method: 'DELETE',
        url: `/customers/${cust1.id}`,
        headers: authHeaders(ownerLogin.token),
      });
      expect(archiveBlocked.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(archiveBlocked.json()).error.code).toBe(
        'CUSTOMER_HAS_OPEN_DEBT',
      );

      const adjRes = await hub.app.inject({
        method: 'POST',
        url: `/customers/${cust1.id}/adjustments`,
        headers: authHeaders(ownerLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000060',
          amountDelta: '-30000',
          reason: 'Chegirma sifatida kechirildi',
        },
      });
      expect(adjRes.statusCode).toBe(201);
      expect(CustomerLedgerMutationResponseSchema.parse(adjRes.json()).customer.balance).toBe('0');

      const ledgerHistory = CustomerLedgerResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: `/customers/${cust1.id}/ledger?order=asc`,
            headers: authHeaders(cashLogin.token),
          })
        ).json(),
      );
      expect(ledgerHistory.items.length).toBe(5);
      expect(ledgerHistory.currentBalance).toBe('0');

      const archiveOk = await hub.app.inject({
        method: 'DELETE',
        url: `/customers/${cust1.id}`,
        headers: authHeaders(ownerLogin.token),
      });
      expect(archiveOk.statusCode).toBe(200);
      expect(ArchiveCustomerResponseSchema.parse(archiveOk.json()).customerId).toBe(cust1.id);

      // Tombstoned phone can be reused cleanly on new customer
      const reuseRes = await hub.app.inject({
        method: 'POST',
        url: '/customers',
        headers: authHeaders(cashLogin.token),
        payload: {
          fullName: 'Qayta Ochildi',
          phone: '+998901234567',
        },
      });
      expect(reuseRes.statusCode).toBe(201);

      // Check SAME-DAY credit sale -> void reverses customer debt via HTTP cleanly
      const cartVoid = await openCart(cashLogin.token);
      await hub.app.inject({
        method: 'POST',
        url: `/carts/${cartVoid}/lines`,
        headers: authHeaders(cashLogin.token),
        payload: { kind: 'catalog', productId: product.id, variantId: null, qty: '1000' }, // 50_000
      });
      const voidDebtSale = CompleteSaleResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: `/carts/${cartVoid}/complete`,
            headers: authHeaders(cashLogin.token),
            payload: {
              clientRequestId: '01950000-0000-7000-8000-170000000070',
              expectedTotal: '50000',
              customerId: cust2.id,
              debtAmount: '50000',
              payments: [],
            },
          })
        ).json(),
      ).sale;

      const voidOkRes = await hub.app.inject({
        method: 'POST',
        url: `/sales/${voidDebtSale.id}/void`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000071',
          reason: 'Xato qarz cheki bekor',
        },
      });
      expect(voidOkRes.statusCode).toBe(200);
      expect(VoidSaleResponseSchema.parse(voidOkRes.json()).sale.status).toBe('voided');

      const cust2Detail = CustomerDetailResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: `/customers/${cust2.id}`,
            headers: authHeaders(cashLogin.token),
          })
        ).json(),
      );
      expect(cust2Detail.customer.balance).toBe('0');

      // Same-day paid credit sale CANNOT be voided -> exact 409 SALE_DEBT_HAS_PAYMENTS
      const cartVoidBlocked = await openCart(cashLogin.token);
      await hub.app.inject({
        method: 'POST',
        url: `/carts/${cartVoidBlocked}/lines`,
        headers: authHeaders(cashLogin.token),
        payload: { kind: 'catalog', productId: product.id, variantId: null, qty: '1000' },
      });
      const paidDebtSale = CompleteSaleResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'POST',
            url: `/carts/${cartVoidBlocked}/complete`,
            headers: authHeaders(cashLogin.token),
            payload: {
              clientRequestId: '01950000-0000-7000-8000-170000000072',
              expectedTotal: '50000',
              customerId: cust2.id,
              debtAmount: '50000',
              payments: [],
            },
          })
        ).json(),
      ).sale;
      await hub.app.inject({
        method: 'POST',
        url: `/customers/${cust2.id}/payments`,
        headers: authHeaders(cashLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000073',
          method: 'card',
          amount: '10000',
        },
      });
      const sameDayVoidBlockedRes = await hub.app.inject({
        method: 'POST',
        url: `/sales/${paidDebtSale.id}/void`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000074',
          reason: 'Tolangan qarz chekini same-day void qilish',
        },
      });
      expect(sameDayVoidBlockedRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(sameDayVoidBlockedRes.json()).error.code).toBe(
        'SALE_DEBT_HAS_PAYMENTS',
      );

      // Archived customer's ledger returns 404; cust2 shows full 4-entry audit history (sale_debt, sale_void, sale_debt, debt_payment)
      const archivedLedgerRes = await hub.app.inject({
        method: 'GET',
        url: `/customers/${cust1.id}/ledger?order=asc`,
        headers: authHeaders(cashLogin.token),
      });
      expect(archivedLedgerRes.statusCode).toBe(404);

      const cust2Ledger = CustomerLedgerResponseSchema.parse(
        (
          await hub.app.inject({
            method: 'GET',
            url: `/customers/${cust2.id}/ledger?order=asc`,
            headers: authHeaders(cashLogin.token),
          })
        ).json(),
      );
      expect(cust2Ledger.items.map((e) => [e.entryType, e.sourceType])).toEqual([
        ['sale_debt', 'sale'],
        ['return_offset', 'sale_void'],
        ['sale_debt', 'sale'],
        ['debt_payment', 'debt_payment'],
      ]);
      expect(cust2Ledger.currentBalance).toBe('40000');

      // Inactive customer: sales rejected (409 CUSTOMER_INACTIVE), debt payment still allowed (201)
      const deactivateRes = await hub.app.inject({
        method: 'PATCH',
        url: `/customers/${cust2.id}`,
        headers: authHeaders(mgrLogin.token),
        payload: { isActive: false },
      });
      expect(deactivateRes.statusCode).toBe(200);
      expect(CustomerMutationResponseSchema.parse(deactivateRes.json()).customer.isActive).toBe(
        false,
      );

      const cartInactive = await openCart(cashLogin.token);
      await hub.app.inject({
        method: 'POST',
        url: `/carts/${cartInactive}/lines`,
        headers: authHeaders(cashLogin.token),
        payload: { kind: 'catalog', productId: product.id, variantId: null, qty: '1000' },
      });
      const inactiveSaleRes = await hub.app.inject({
        method: 'POST',
        url: `/carts/${cartInactive}/complete`,
        headers: authHeaders(cashLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000080',
          expectedTotal: '50000',
          customerId: cust2.id,
          debtAmount: '50000',
          payments: [],
        },
      });
      expect(inactiveSaleRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(inactiveSaleRes.json()).error.code).toBe(
        'CUSTOMER_INACTIVE',
      );

      const inactivePayRes = await hub.app.inject({
        method: 'POST',
        url: `/customers/${cust2.id}/payments`,
        headers: authHeaders(cashLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-170000000081',
          method: 'card',
          amount: '10000',
        },
      });
      expect(inactivePayRes.statusCode).toBe(201);
      expect(
        CustomerLedgerMutationResponseSchema.parse(inactivePayRes.json()).customer.balance,
      ).toBe('30000');

      // 8. SECURITY AUDIT: Zero customer PII in Pino logs & HTTP errors; Zero cost/profit/hash keys in DTOs
      const joinedLogs = logLines.join('\n');
      expect(joinedLogs).not.toContain('SecretMijoz');
      expect(joinedLogs).not.toContain('901234567');
      expect(joinedLogs).not.toContain('9995554433');
      expect(joinedLogs).not.toContain('000999888777');
      expect(joinedLogs).not.toContain(ownerPin);
      expect(joinedLogs).not.toContain(mgrPin);
      expect(joinedLogs).not.toContain(cashierPin);

      const allJsonKeys = new Set([
        ...collectJsonKeysDeep(cust2Detail),
        ...collectJsonKeysDeep(ledgerHistory),
        ...collectJsonKeysDeep(cashPayDto),
        ...collectJsonKeysDeep(overdueDto),
      ]);
      for (const forbiddenKey of [
        'costValue',
        'unitCost',
        'profit',
        'grossProfit',
        'pinHash',
        'pin_hash',
        'tokenHash',
        'phoneDigits',
        'nameSearch',
      ]) {
        expect(allJsonKeys.has(forbiddenKey)).toBe(false);
      }
    } finally {
      await hub.close();
    }
  }, 20_000);

  it('T1.7 test debt: redacts EVERY PII key at top, *. and *.*. levels via real Pino logger loop', () => {
    const requiredPiiKeys = [
      'phone',
      'phoneNormalized',
      'phoneDigits',
      'fullName',
      'nameSearch',
      'customerName',
      'customerPhone',
      'customerNote',
      'note',
    ] as const;

    const allKeys = Array.from(new Set([...requiredPiiKeys, ...PII_LOG_REDACT_KEYS]));
    const rawLines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        rawLines.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        callback();
      },
    });
    const logger = createHubLogger({ level: 'info', stream });

    for (let idx = 0; idx < allKeys.length; idx += 1) {
      const key = allKeys[idx];
      if (!key) continue;
      const secretTop = `SECRET_TOP_${idx}_${key}`;
      const secretNested = `SECRET_NESTED_${idx}_${key}`;
      const secretDeep = `SECRET_DEEP_${idx}_${key}`;

      rawLines.length = 0;
      logger.info(
        {
          [key]: secretTop,
          nested: { [key]: secretNested },
          req: { body: { [key]: secretDeep } },
        },
        'PII redaction loop check',
      );

      const line = rawLines.join('');
      expect(line).not.toContain(secretTop);
      expect(line).not.toContain(secretNested);
      expect(line).not.toContain(secretDeep);

      const parsed = JSON.parse(line) as {
        readonly nested: Record<string, unknown>;
        readonly req: { readonly body: Record<string, unknown> };
      } & Record<string, unknown>;
      expect(parsed[key]).toBe('[Redacted]');
      expect(parsed.nested[key]).toBe('[Redacted]');
      expect(parsed.req.body[key]).toBe('[Redacted]');
    }

    for (const reqKey of requiredPiiKeys) {
      expect(PII_LOG_REDACT_KEYS).toContain(reqKey);
    }
  });
});
