import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  ApiErrorEnvelopeSchema,
  ArchiveSupplierResponseSchema,
  ConfirmReceivingCostResponseSchema,
  CreateSupplierReturnResponseSchema,
  ListSupplierReturnsResponseSchema,
  LoginResponseSchema,
  PostReceivingResponseSchema,
  ProductDetailResponseSchema,
  ReceivingDraftResponseSchema,
  ReceivingDtoSchema,
  ReceivingListResponseSchema,
  SupplierDetailResponseSchema,
  SupplierLedgerMutationResponseSchema,
  SupplierLedgerResponseSchema,
  SupplierListResponseSchema,
  SupplierMutationResponseSchema,
  SupplierReturnDtoSchema,
} from '@mezon/contracts';
import { type PinHasher } from '@mezon/domain';
import { PII_LOG_REDACT_KEYS } from '@mezon/drivers/node';
import { FixedClock, SeededRandomSource } from '@mezon/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubLogger } from './logger.js';
import { createHubServer } from './server.js';

const tempDirs: string[] = [];
const TEST_PORT = 47849;
const HOST_HEADER = `127.0.0.1:${TEST_PORT}`;

// 2026-06-15 10:00:00+05:00 (05:00:00Z)
const DAY1_1000_UTC_MS = BigInt(Date.parse('2026-06-15T05:00:00.000Z'));

function makeDbPath(name = 'hub-supplier.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezon-hub-supplier-'));
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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  }
});

describe('@mezon/hub - T1.8 Suppliers, Receiving, Unknown Cost, E1-E3, RBAC & PII Audit', () => {
  it('enforces owner/manager-only RBAC (cashier 403 across ALL supplier/receiving/return routes), E1/E2/E3 HTTP workflows, drawer check & zero-PII logs', async () => {
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
      random: new SeededRandomSource(188),
      pinHasher: makeFastTestHasher(),
      logLevel: 'info',
      logStream,
    });

    const ownerPin = '849201';
    const mgrPin = '592817';
    const cashierPin = '374829';

    const piiSupName = 'Maxfiy Taminotchi Yoqub';
    const piiTin = '309123456';
    const piiPhone = '90 888-77-66';
    const piiContact = 'Yoqubjon Qodirov';
    const piiNote = 'Ichki chegirma sharti';

    try {
      const setupRes = await hub.app.inject({
        method: 'POST',
        url: '/setup',
        headers: hostHeaders(),
        payload: { owner: { fullName: 'Owner', username: 'owner18', pin: ownerPin } },
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

      let ownerLogin = await loginAs('owner18', ownerPin);
      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerLogin.token),
        payload: { fullName: 'Manager', username: 'mgr18', role: 'manager', pin: mgrPin },
      });
      await hub.app.inject({
        method: 'POST',
        url: '/users',
        headers: authHeaders(ownerLogin.token),
        payload: { fullName: 'Cashier', username: 'cash18', role: 'cashier', pin: cashierPin },
      });

      let mgrLogin = await loginAs('mgr18', mgrPin);
      let cashLogin = await loginAs('cash18', cashierPin);

      const shiftOpen18 = await hub.app.inject({
        method: 'POST',
        url: '/shifts/open',
        headers: authHeaders(ownerLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-1800000000a1',
          openingCash: '0',
        },
      });
      expect(shiftOpen18.statusCode).toBe(201);

      // Seed catalog products
      const prodRes = await hub.app.inject({
        method: 'POST',
        url: '/products',
        headers: authHeaders(ownerLogin.token),
        payload: {
          name: 'Kofe Gold 200g',
          unit: 'dona',
          trackBatches: true,
          salePrice: '60000',
          vatRateBp: 1200,
        },
      });
      expect(prodRes.statusCode).toBe(201);
      const product = ProductDetailResponseSchema.parse(prodRes.json()).product;

      const avgProdRes = await hub.app.inject({
        method: 'POST',
        url: '/products',
        headers: authHeaders(ownerLogin.token),
        payload: {
          name: 'Qand Avg',
          unit: 'kg',
          trackBatches: false,
          salePrice: '20000',
          vatRateBp: 0,
        },
      });
      const avgProduct = ProductDetailResponseSchema.parse(avgProdRes.json()).product;

      // 1) Unauthenticated -> 401
      const unauthRes = await hub.app.inject({
        method: 'GET',
        url: '/suppliers',
        headers: hostHeaders(),
      });
      expect(unauthRes.statusCode).toBe(401);

      // 2) Manager creates supplier, tests duplicate TIN 409 without leaking raw TIN
      const supCreateRes = await hub.app.inject({
        method: 'POST',
        url: '/suppliers',
        headers: authHeaders(mgrLogin.token),
        payload: {
          name: piiSupName,
          tin: piiTin,
          phone: piiPhone,
          contactPerson: piiContact,
          defaultDueDays: 5,
          note: piiNote,
        },
      });
      expect(supCreateRes.statusCode).toBe(201);
      const sup1 = SupplierMutationResponseSchema.parse(supCreateRes.json()).supplier;
      expect(sup1.tin).toBe(piiTin);
      expect(sup1.phoneNormalized).toBe('+998908887766');

      const dupTinRes = await hub.app.inject({
        method: 'POST',
        url: '/suppliers',
        headers: authHeaders(ownerLogin.token),
        payload: { name: 'Dup Co', tin: piiTin },
      });
      expect(dupTinRes.statusCode).toBe(409);
      const dupErr = ApiErrorEnvelopeSchema.parse(dupTinRes.json());
      expect(dupErr.error.code).toBe('SUPPLIER_TIN_ALREADY_EXISTS');
      expect(dupErr.error.message).not.toContain(piiTin);

      // List & Search suppliers
      const searchRes = await hub.app.inject({
        method: 'GET',
        url: `/suppliers?q=${piiTin}`,
        headers: authHeaders(mgrLogin.token),
      });
      expect(searchRes.statusCode).toBe(200);
      expect(SupplierListResponseSchema.parse(searchRes.json()).items.map((s) => s.id)).toEqual([
        sup1.id,
      ]);

      // 3) Opening balance (`201`, replay `200`, dup `409`)
      const obReqId = '01950000-0000-7000-8000-180000000001';
      const obRes = await hub.app.inject({
        method: 'POST',
        url: `/suppliers/${sup1.id}/opening-balance`,
        headers: authHeaders(ownerLogin.token),
        payload: {
          clientRequestId: obReqId,
          amount: '100000',
          reason: 'Boshlangich qarz',
          dueDays: 3,
        },
      });
      expect(obRes.statusCode).toBe(201);
      expect(SupplierLedgerMutationResponseSchema.parse(obRes.json()).supplier.balance).toBe(
        '100000',
      );

      const obReplayRes = await hub.app.inject({
        method: 'POST',
        url: `/suppliers/${sup1.id}/opening-balance`,
        headers: authHeaders(ownerLogin.token),
        payload: {
          clientRequestId: obReqId,
          amount: '100000',
          reason: 'Boshlangich qarz',
          dueDays: 3,
        },
      });
      expect(obReplayRes.statusCode).toBe(200);
      expect(SupplierLedgerMutationResponseSchema.parse(obReplayRes.json()).idempotentReplay).toBe(
        true,
      );

      // 4) Receiving Draft lifecycle: create, edit, cancel, empty post guard
      const cancelDraftRes = await hub.app.inject({
        method: 'POST',
        url: '/receiving-drafts',
        headers: authHeaders(mgrLogin.token),
        payload: {
          supplierId: sup1.id,
          lines: [
            {
              productId: product.id,
              qty: '2000',
              costUnknown: false,
              totalCostValue: '50000',
            },
          ],
        },
      });
      expect(cancelDraftRes.statusCode).toBe(201);
      const cancelDraftId = ReceivingDraftResponseSchema.parse(cancelDraftRes.json()).draft.id;
      const cancelledRes = await hub.app.inject({
        method: 'POST',
        url: `/receiving-drafts/${cancelDraftId}/cancel`,
        headers: authHeaders(mgrLogin.token),
      });
      expect(cancelledRes.statusCode).toBe(200);
      expect(ReceivingDraftResponseSchema.parse(cancelledRes.json()).draft.status).toBe(
        'cancelled',
      );

      const postCancelledRes = await hub.app.inject({
        method: 'POST',
        url: `/receiving-drafts/${cancelDraftId}/post`,
        headers: authHeaders(mgrLogin.token),
        payload: { clientRequestId: '01950000-0000-7000-8000-180000000002' },
      });
      expect(postCancelledRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(postCancelledRes.json()).error.code).toBe(
        'RECEIVING_NOT_DRAFT',
      );

      const emptyDraftRes = await hub.app.inject({
        method: 'POST',
        url: '/receiving-drafts',
        headers: authHeaders(mgrLogin.token),
        payload: { supplierId: sup1.id },
      });
      const emptyDraftId = ReceivingDraftResponseSchema.parse(emptyDraftRes.json()).draft.id;
      const postEmptyRes = await hub.app.inject({
        method: 'POST',
        url: `/receiving-drafts/${emptyDraftId}/post`,
        headers: authHeaders(mgrLogin.token),
        payload: { clientRequestId: '01950000-0000-7000-8000-180000000003' },
      });
      expect(postEmptyRes.statusCode).toBe(400);
      expect(ApiErrorEnvelopeSchema.parse(postEmptyRes.json()).error.code).toBe('RECEIVING_EMPTY');

      // 5) Mixed known + unknown receiving -> E1 cost confirmation & E2 return via HTTP
      const draftRes = await hub.app.inject({
        method: 'POST',
        url: '/receiving-drafts',
        headers: authHeaders(mgrLogin.token),
        payload: {
          supplierId: sup1.id,
          supplierInvoiceNo: 'INV-HUB-1',
          lines: [
            {
              productId: product.id,
              qty: '5000',
              costUnknown: false,
              totalCostValue: '150000',
              batchNumber: 'HUB-K1',
            },
            {
              productId: avgProduct.id,
              qty: '4000',
              costUnknown: true,
              totalCostValue: null,
            },
          ],
        },
      });
      expect(draftRes.statusCode).toBe(201);
      const draftId = ReceivingDraftResponseSchema.parse(draftRes.json()).draft.id;

      const patchDraftRes = await hub.app.inject({
        method: 'PATCH',
        url: `/receiving-drafts/${draftId}`,
        headers: authHeaders(mgrLogin.token),
        payload: { note: 'Edited draft note' },
      });
      expect(patchDraftRes.statusCode).toBe(200);
      expect(ReceivingDraftResponseSchema.parse(patchDraftRes.json()).draft.note).toBe(
        'Edited draft note',
      );

      const postReqId = '01950000-0000-7000-8000-180000000010';
      const postRes = await hub.app.inject({
        method: 'POST',
        url: `/receiving-drafts/${draftId}/post`,
        headers: authHeaders(mgrLogin.token),
        payload: { clientRequestId: postReqId },
      });
      expect(postRes.statusCode).toBe(201);
      const posted = PostReceivingResponseSchema.parse(postRes.json());
      expect(posted.receiving.knownCostTotal).toBe('150000');
      expect(posted.receiving.unknownCostLineCount).toBe(1);
      expect(posted.supplier.balance).toBe('250000'); // 100k opening + 150k known

      const knownLine = posted.receiving.lines[0];
      const unkLine = posted.receiving.lines[1];

      // Replay post -> 200
      const postReplay = await hub.app.inject({
        method: 'POST',
        url: `/receiving-drafts/${draftId}/post`,
        headers: authHeaders(mgrLogin.token),
        payload: { clientRequestId: postReqId },
      });
      expect(postReplay.statusCode).toBe(200);
      expect(PostReceivingResponseSchema.parse(postReplay.json()).idempotentReplay).toBe(true);

      // List unknown receivings
      const unkListRes = await hub.app.inject({
        method: 'GET',
        url: '/receivings?costUnknownOnly=true&status=posted',
        headers: authHeaders(mgrLogin.token),
      });
      expect(unkListRes.statusCode).toBe(200);
      expect(ReceivingListResponseSchema.parse(unkListRes.json()).items.map((r) => r.id)).toEqual([
        posted.receiving.id,
      ]);

      // Returning unconfirmed unknown-cost line rejected with 409 RECEIVING_LINE_COST_UNKNOWN
      const retUnkRes = await hub.app.inject({
        method: 'POST',
        url: `/receivings/${posted.receiving.id}/returns`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-180000000011',
          reason: 'Narx yoq qaytarish',
          items: [{ receivingLineId: unkLine.id, qty: '1000' }],
        },
      });
      expect(retUnkRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(retUnkRes.json()).error.code).toBe(
        'RECEIVING_LINE_COST_UNKNOWN',
      );

      // Confirm cost on unknown line -> 201
      const confReqId = '01950000-0000-7000-8000-180000000012';
      const confRes = await hub.app.inject({
        method: 'POST',
        url: `/receivings/${posted.receiving.id}/lines/${unkLine.id}/confirm-cost`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: confReqId,
          confirmedTotalCost: '80000',
          reason: 'Nakladnoy keldi',
        },
      });
      expect(confRes.statusCode).toBe(201);
      const confDto = ConfirmReceivingCostResponseSchema.parse(confRes.json());
      expect(confDto.supplier.balance).toBe('330000'); // 250k + 80k

      // Return partial qty on known line -> 201
      const retRes = await hub.app.inject({
        method: 'POST',
        url: `/receivings/${posted.receiving.id}/returns`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-180000000013',
          reason: 'Buzilgan qadoq',
          items: [{ receivingLineId: knownLine.id, qty: '1000' }],
        },
      });
      expect(retRes.statusCode).toBe(201);
      const retDto = CreateSupplierReturnResponseSchema.parse(retRes.json());
      expect(retDto.supplierReturn.totalReturnCost).toBe('30000');
      expect(retDto.supplier.balance).toBe('300000'); // 330k - 30k

      // Excess return -> 409 SUPPLIER_RETURN_QTY_EXCEEDED
      const retExcessRes = await hub.app.inject({
        method: 'POST',
        url: `/receivings/${posted.receiving.id}/returns`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-180000000014',
          reason: 'Ortiqcha',
          items: [{ receivingLineId: knownLine.id, qty: '5000' }],
        },
      });
      expect(retExcessRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(retExcessRes.json()).error.code).toBe(
        'SUPPLIER_RETURN_QTY_EXCEEDED',
      );

      // GET return endpoints
      const listRetRes = await hub.app.inject({
        method: 'GET',
        url: `/receivings/${posted.receiving.id}/returns`,
        headers: authHeaders(mgrLogin.token),
      });
      expect(listRetRes.statusCode).toBe(200);
      expect(ListSupplierReturnsResponseSchema.parse(listRetRes.json()).returns).toHaveLength(1);

      const getRetRes = await hub.app.inject({
        method: 'GET',
        url: `/supplier-returns/${retDto.supplierReturn.id}`,
        headers: authHeaders(mgrLogin.token),
      });
      expect(getRetRes.statusCode).toBe(200);
      expect(SupplierReturnDtoSchema.parse(getRetRes.json()).id).toBe(retDto.supplierReturn.id);

      // GET receiving & draft endpoints
      const getRcvRes = await hub.app.inject({
        method: 'GET',
        url: `/receivings/${posted.receiving.id}`,
        headers: authHeaders(mgrLogin.token),
      });
      expect(getRcvRes.statusCode).toBe(200);
      expect(ReceivingDtoSchema.parse(getRcvRes.json()).unknownCostLineCount).toBe(0);

      const getDraftRes = await hub.app.inject({
        method: 'GET',
        url: `/receiving-drafts/${draftId}`,
        headers: authHeaders(mgrLogin.token),
      });
      expect(getDraftRes.statusCode).toBe(200);
      expect(ReceivingDraftResponseSchema.parse(getDraftRes.json()).draft.status).toBe('posted');

      // 6) Cash payment drawer check (`409 INSUFFICIENT_CASH_IN_DRAWER`), social_card block, card advance (`balance < 0`)
      const cashFailRes = await hub.app.inject({
        method: 'POST',
        url: `/suppliers/${sup1.id}/payments`,
        headers: authHeaders(ownerLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-180000000020',
          method: 'cash',
          amount: '50000',
        },
      });
      expect(cashFailRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(cashFailRes.json()).error.code).toBe(
        'INSUFFICIENT_CASH_IN_DRAWER',
      );

      const socialFailRes = await hub.app.inject({
        method: 'POST',
        url: `/suppliers/${sup1.id}/payments`,
        headers: authHeaders(ownerLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-180000000021',
          method: 'social_card',
          amount: '50000',
        },
      });
      expect(socialFailRes.statusCode).toBe(400);

      // Pay 350k by card -> -50k advance balance (< 0)
      const cardPayRes = await hub.app.inject({
        method: 'POST',
        url: `/suppliers/${sup1.id}/payments`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-180000000022',
          method: 'card',
          providerRef: 'UZCARD-7788',
          amount: '350000',
          reason: 'Avans bilan tolov',
        },
      });
      expect(cardPayRes.statusCode).toBe(201);
      const cardDto = SupplierLedgerMutationResponseSchema.parse(cardPayRes.json());
      expect(cardDto.supplier.balance).toBe('-50000');
      expect(cardDto.supplier.advanceBalance).toBe('50000');

      // Archive blocked while non-zero (advance) balance
      const archiveBlockedRes = await hub.app.inject({
        method: 'DELETE',
        url: `/suppliers/${sup1.id}`,
        headers: authHeaders(ownerLogin.token),
      });
      expect(archiveBlockedRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(archiveBlockedRes.json()).error.code).toBe(
        'SUPPLIER_HAS_OPEN_BALANCE',
      );

      // Adjustment & ledger history
      const adjRes = await hub.app.inject({
        method: 'POST',
        url: `/suppliers/${sup1.id}/adjustments`,
        headers: authHeaders(ownerLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-180000000023',
          amountDelta: '150000',
          reason: 'Qarz tuzatish',
          dueDays: 2,
        },
      });
      expect(adjRes.statusCode).toBe(201);
      expect(SupplierLedgerMutationResponseSchema.parse(adjRes.json()).supplier.balance).toBe(
        '100000',
      );

      // Advance clock -> refresh expired 12h session tokens & check overdue
      clock.advance(4n * 86_400_000n);
      ownerLogin = await loginAs('owner18', ownerPin);
      mgrLogin = await loginAs('mgr18', mgrPin);
      cashLogin = await loginAs('cash18', cashierPin);
      const overdueRes = await hub.app.inject({
        method: 'GET',
        url: '/suppliers/overdue',
        headers: authHeaders(mgrLogin.token),
      });
      expect(overdueRes.statusCode).toBe(200);
      expect(SupplierListResponseSchema.parse(overdueRes.json()).items[0]?.overdueAmount).toBe(
        '100000',
      );

      const detailRes = await hub.app.inject({
        method: 'GET',
        url: `/suppliers/${sup1.id}`,
        headers: authHeaders(ownerLogin.token),
      });
      expect(detailRes.statusCode).toBe(200);
      expect(SupplierDetailResponseSchema.parse(detailRes.json()).openObligations).toHaveLength(1);

      const ledgerRes = await hub.app.inject({
        method: 'GET',
        url: `/suppliers/${sup1.id}/ledger?order=asc`,
        headers: authHeaders(mgrLogin.token),
      });
      expect(ledgerRes.statusCode).toBe(200);
      expect(
        SupplierLedgerResponseSchema.parse(ledgerRes.json()).items.length,
      ).toBeGreaterThanOrEqual(5);

      // 7) E3 via HTTP: Create 2nd unknown receiving draft + deactivate supplier -> post returns 409 SUPPLIER_INACTIVE,
      // while payment, confirm-cost, and return on earlier receiving succeed!
      const draft2Res = await hub.app.inject({
        method: 'POST',
        url: '/receiving-drafts',
        headers: authHeaders(mgrLogin.token),
        payload: {
          supplierId: sup1.id,
          lines: [
            { productId: avgProduct.id, qty: '2000', costUnknown: true, totalCostValue: null },
          ],
        },
      });
      const posted2Res = await hub.app.inject({
        method: 'POST',
        url: `/receiving-drafts/${ReceivingDraftResponseSchema.parse(draft2Res.json()).draft.id}/post`,
        headers: authHeaders(mgrLogin.token),
        payload: { clientRequestId: '01950000-0000-7000-8000-180000000030' },
      });
      const posted2 = PostReceivingResponseSchema.parse(posted2Res.json()).receiving;

      const draftBlockedRes = await hub.app.inject({
        method: 'POST',
        url: '/receiving-drafts',
        headers: authHeaders(mgrLogin.token),
        payload: {
          supplierId: sup1.id,
          lines: [
            {
              productId: avgProduct.id,
              qty: '1000',
              costUnknown: false,
              totalCostValue: '10000',
            },
          ],
        },
      });
      const draftBlockedId = ReceivingDraftResponseSchema.parse(draftBlockedRes.json()).draft.id;

      // Deactivate supplier
      const deactivateRes = await hub.app.inject({
        method: 'PATCH',
        url: `/suppliers/${sup1.id}`,
        headers: authHeaders(ownerLogin.token),
        payload: { isActive: false },
      });
      expect(deactivateRes.statusCode).toBe(200);

      // Blocked post -> 409 SUPPLIER_INACTIVE
      const blockedPostRes = await hub.app.inject({
        method: 'POST',
        url: `/receiving-drafts/${draftBlockedId}/post`,
        headers: authHeaders(ownerLogin.token),
        payload: { clientRequestId: '01950000-0000-7000-8000-180000000031' },
      });
      expect(blockedPostRes.statusCode).toBe(409);
      expect(ApiErrorEnvelopeSchema.parse(blockedPostRes.json()).error.code).toBe(
        'SUPPLIER_INACTIVE',
      );

      // Payment succeeds
      const e3PayRes = await hub.app.inject({
        method: 'POST',
        url: `/suppliers/${sup1.id}/payments`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-180000000032',
          method: 'card',
          amount: '50000',
        },
      });
      expect(e3PayRes.statusCode).toBe(201);

      // Cost confirm succeeds
      const e3ConfRes = await hub.app.inject({
        method: 'POST',
        url: `/receivings/${posted2.id}/lines/${posted2.lines[0].id}/confirm-cost`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-180000000033',
          confirmedTotalCost: '20000',
          reason: 'E3 inactive confirm',
        },
      });
      expect(e3ConfRes.statusCode).toBe(201);

      // Return succeeds
      const e3RetRes = await hub.app.inject({
        method: 'POST',
        url: `/receivings/${posted2.id}/returns`,
        headers: authHeaders(mgrLogin.token),
        payload: {
          clientRequestId: '01950000-0000-7000-8000-180000000034',
          reason: 'E3 inactive return',
          items: [{ receivingLineId: posted2.lines[0].id, qty: '1000' }],
        },
      });
      expect(e3RetRes.statusCode).toBe(201);

      // 8) Cashier receives 403 AUTH_FORBIDDEN across EVERY single T1.8 endpoint!
      const cashierForbiddenChecks: Array<{
        readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
        readonly url: string;
        readonly payload?: Record<string, unknown>;
      }> = [
        { method: 'GET', url: '/suppliers' },
        { method: 'GET', url: '/suppliers/overdue' },
        { method: 'GET', url: `/suppliers/${sup1.id}` },
        { method: 'GET', url: `/suppliers/${sup1.id}/ledger` },
        { method: 'POST', url: '/suppliers', payload: { name: 'Cashier Blocked' } },
        { method: 'PATCH', url: `/suppliers/${sup1.id}`, payload: { name: 'Edit Blocked' } },
        { method: 'DELETE', url: `/suppliers/${sup1.id}` },
        {
          method: 'POST',
          url: `/suppliers/${sup1.id}/opening-balance`,
          payload: {
            clientRequestId: '01950000-0000-7000-8000-180000000090',
            amount: '1000',
            reason: 'Nope',
          },
        },
        {
          method: 'POST',
          url: `/suppliers/${sup1.id}/payments`,
          payload: {
            clientRequestId: '01950000-0000-7000-8000-180000000091',
            method: 'card',
            amount: '1000',
          },
        },
        {
          method: 'POST',
          url: `/suppliers/${sup1.id}/adjustments`,
          payload: {
            clientRequestId: '01950000-0000-7000-8000-180000000092',
            amountDelta: '1000',
            reason: 'Nope',
          },
        },
        { method: 'GET', url: '/receivings' },
        { method: 'POST', url: '/receiving-drafts', payload: { supplierId: sup1.id } },
        { method: 'GET', url: `/receiving-drafts/${draftId}` },
        {
          method: 'PATCH',
          url: `/receiving-drafts/${draftBlockedId}`,
          payload: { note: 'Blocked' },
        },
        { method: 'POST', url: `/receiving-drafts/${draftBlockedId}/cancel` },
        {
          method: 'POST',
          url: `/receiving-drafts/${draftBlockedId}/post`,
          payload: { clientRequestId: '01950000-0000-7000-8000-180000000093' },
        },
        { method: 'GET', url: `/receivings/${posted.receiving.id}` },
        {
          method: 'POST',
          url: `/receivings/${posted.receiving.id}/lines/${unkLine.id}/confirm-cost`,
          payload: {
            clientRequestId: '01950000-0000-7000-8000-180000000094',
            confirmedTotalCost: '1000',
            reason: 'Nope',
          },
        },
        {
          method: 'POST',
          url: `/receivings/${posted.receiving.id}/returns`,
          payload: {
            clientRequestId: '01950000-0000-7000-8000-180000000095',
            reason: 'Nope',
            items: [{ receivingLineId: knownLine.id, qty: '1000' }],
          },
        },
        { method: 'GET', url: `/receivings/${posted.receiving.id}/returns` },
        { method: 'GET', url: `/supplier-returns/${retDto.supplierReturn.id}` },
      ];

      for (const req of cashierForbiddenChecks) {
        const res = await hub.app.inject({
          method: req.method,
          url: req.url,
          headers: authHeaders(cashLogin.token),
          ...(req.payload !== undefined ? { payload: req.payload } : {}),
        });
        expect(res.statusCode, `${req.method} ${req.url} must return 403 for cashier`).toBe(403);
        expect(ApiErrorEnvelopeSchema.parse(res.json()).error.code).toBe('AUTH_FORBIDDEN');
      }

      // 9) Archive a separate clean zero-balance supplier -> 200
      const cleanSupRes = await hub.app.inject({
        method: 'POST',
        url: '/suppliers',
        headers: authHeaders(ownerLogin.token),
        payload: { name: 'Archive Clean Co' },
      });
      const cleanSupId = SupplierMutationResponseSchema.parse(cleanSupRes.json()).supplier.id;
      const archRes = await hub.app.inject({
        method: 'DELETE',
        url: `/suppliers/${cleanSupId}`,
        headers: authHeaders(ownerLogin.token),
      });
      expect(archRes.statusCode).toBe(200);
      expect(ArchiveSupplierResponseSchema.parse(archRes.json()).supplierId).toBe(cleanSupId);

      // 10) Zero Supplier PII / Secret Leak Audit in Pino Logs
      const joinedLogs = logLines.join('\n');
      expect(joinedLogs).not.toContain(piiSupName);
      expect(joinedLogs).not.toContain(piiTin);
      expect(joinedLogs).not.toContain('908887766');
      expect(joinedLogs).not.toContain(piiContact);
      expect(joinedLogs).not.toContain(piiNote);
      expect(joinedLogs).not.toContain(ownerPin);
      expect(joinedLogs).not.toContain(mgrPin);
      expect(joinedLogs).not.toContain(cashierPin);
    } finally {
      await hub.close();
    }
  }, 20_000);

  it('redacts T1.8 supplier PII keys (supplierName, contactPerson, supplierPhone, supplierNote, tin, note) at top, *. and *.*. levels via Pino logger', () => {
    const requiredKeys = [
      'supplierName',
      'contactPerson',
      'supplierPhone',
      'supplierNote',
      'tin',
      'note',
    ] as const;

    const allKeys = Array.from(new Set([...requiredKeys, ...PII_LOG_REDACT_KEYS]));
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
      const sTop = `TOP_${idx}_${key}`;
      const sNest = `NEST_${idx}_${key}`;
      const sDeep = `DEEP_${idx}_${key}`;

      rawLines.length = 0;
      logger.info(
        {
          [key]: sTop,
          nested: { [key]: sNest },
          req: { body: { [key]: sDeep } },
        },
        'Supplier PII redaction check',
      );

      const line = rawLines.join('');
      expect(line).not.toContain(sTop);
      expect(line).not.toContain(sNest);
      expect(line).not.toContain(sDeep);

      const parsed = JSON.parse(line) as {
        readonly nested: Record<string, unknown>;
        readonly req: { readonly body: Record<string, unknown> };
      } & Record<string, unknown>;
      expect(parsed[key]).toBe('[Redacted]');
      expect(parsed.nested[key]).toBe('[Redacted]');
      expect(parsed.req.body[key]).toBe('[Redacted]');
    }
  });
});
