import {
  OpenCashDrawerRequestSchema,
  PrintDocumentRequestSchema,
  ReturnIdParamsSchema,
  SaleIdParamsSchema,
  ShiftIdParamsSchema,
  UpdatePrinterSettingsRequestSchema,
} from '@mezon/contracts';
import type { HubPermission } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HubAuthService } from './auth-service.js';
import type { HubPrinterService } from './printer-service.js';

async function authorize(
  authService: HubAuthService,
  request: FastifyRequest,
  permission: HubPermission,
) {
  const session = await authService.authenticate(request.headers.authorization);
  authService.assertPermission(session, permission);
  return session;
}

export function registerPrinterRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  printerService: HubPrinterService,
): void {
  app.get('/printer/settings', async (request) => {
    await authorize(authService, request, 'auth:self');
    return printerService.getSettings();
  });

  app.patch('/printer/settings', async (request) => {
    const session = await authorize(authService, request, 'printer:config');
    const body = UpdatePrinterSettingsRequestSchema.parse(request.body);
    const res = await printerService.updateSettings(body);
    request.log.info(
      {
        event: 'printer.settings_updated',
        actorUserId: session.user.id,
        mode: res.settings.mode,
        paperWidthMm: res.settings.paperWidthMm,
        encoding: res.settings.encoding,
      },
      'Updated hub printer settings',
    );
    return res;
  });

  app.get('/printer/windows-printers', async (request) => {
    await authorize(authService, request, 'printer:config');
    return printerService.listWindowsPrinters();
  });

  app.post('/printer/test-print', async (request) => {
    const session = await authorize(authService, request, 'printer:config');
    const res = await printerService.testPrint();
    request.log.info(
      {
        event: 'printer.test_printed',
        actorUserId: session.user.id,
        status: res.status,
        printerMode: res.printerMode,
        errorCode: res.errorCode,
      },
      'Executed printer test receipt',
    );
    return res;
  });

  app.post('/printer/cash-drawer/open', async (request) => {
    const session = await authService.authenticate(request.headers.authorization);
    const body = OpenCashDrawerRequestSchema.parse(request.body);
    const { response, overrideApprovedByUserId } = await printerService.openCashDrawer(
      session,
      body,
    );
    request.log.info(
      {
        event: 'printer.cash_drawer_opened',
        actorUserId: session.user.id,
        overrideApprovedByUserId,
        status: response.event.status,
        reason: response.event.reason,
        idempotentReplay: response.idempotentReplay,
      },
      'Manual cash drawer open requested',
    );
    return response;
  });

  app.post('/sales/:id/print', async (request) => {
    const session = await authorize(authService, request, 'cart:write');
    const params = SaleIdParamsSchema.parse(request.params);
    const body = PrintDocumentRequestSchema.parse(request.body);
    const res = await printerService.printSaleReceipt(params.id, session, body);
    request.log.info(
      {
        event: 'sale.receipt_printed',
        saleId: params.id,
        printId: res.printRecord.id,
        printSeq: res.printRecord.printSeq,
        copyNumber: res.printRecord.copyNumber,
        isReprint: res.printRecord.isReprint,
        status: res.printRecord.status,
        errorCode: res.printRecord.errorCode,
        idempotentReplay: res.idempotentReplay,
      },
      'Processed sale receipt print',
    );
    return res;
  });

  app.get('/sales/:id/prints', async (request) => {
    await authorize(authService, request, 'cart:write');
    const params = SaleIdParamsSchema.parse(request.params);
    return printerService.listSalePrints(params.id);
  });

  app.post('/returns/:id/print', async (request) => {
    const session = await authorize(authService, request, 'cart:write');
    const params = ReturnIdParamsSchema.parse(request.params);
    const body = PrintDocumentRequestSchema.parse(request.body);
    const res = await printerService.printReturnReceipt(params.id, session, body);
    request.log.info(
      {
        event: 'return.receipt_printed',
        returnId: params.id,
        printId: res.printRecord.id,
        copyNumber: res.printRecord.copyNumber,
        isReprint: res.printRecord.isReprint,
        status: res.printRecord.status,
        idempotentReplay: res.idempotentReplay,
      },
      'Processed return receipt print',
    );
    return res;
  });

  app.post('/shifts/:id/print-close-report', async (request) => {
    const session = await authorize(authService, request, 'shifts:read');
    const params = ShiftIdParamsSchema.parse(request.params);
    const body = PrintDocumentRequestSchema.parse(request.body);
    const res = await printerService.printShiftCloseReport(params.id, session, body);
    request.log.info(
      {
        event: 'shift.close_report_printed',
        shiftId: params.id,
        printId: res.printRecord.id,
        copyNumber: res.printRecord.copyNumber,
        isReprint: res.printRecord.isReprint,
        status: res.printRecord.status,
        idempotentReplay: res.idempotentReplay,
      },
      'Processed shift close report print',
    );
    return res;
  });
}
