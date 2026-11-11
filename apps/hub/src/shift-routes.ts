import {
  CloseBusinessDayRequestSchema,
  CloseShiftRequestSchema,
  CreateShiftCashMoveRequestSchema,
  DayCloseListQuerySchema,
  HandoffCashierRequestSchema,
  OpenShiftRequestSchema,
  RecloseShiftRequestSchema,
  ShiftIdParamsSchema,
  ShiftListQuerySchema,
  UpdateShiftSettingsRequestSchema,
} from '@mezon/contracts';
import type { HubPermission } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HubAuthService } from './auth-service.js';
import type { HubShiftService } from './shift-service.js';

async function authorize(
  authService: HubAuthService,
  request: FastifyRequest,
  permission: HubPermission,
) {
  const session = await authService.authenticate(request.headers.authorization);
  authService.assertPermission(session, permission);
  return session;
}

export function registerShiftRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  shiftService: HubShiftService,
): void {
  // Static routes MUST precede parameterized '/shifts/:id'
  app.get('/shifts/current', async (request) => {
    await authorize(authService, request, 'shifts:read');
    return shiftService.getCurrentShift();
  });

  app.patch('/shifts/settings', async (request) => {
    const session = await authorize(authService, request, 'discounts:config');
    const body = UpdateShiftSettingsRequestSchema.parse(request.body);
    const res = await shiftService.updateSettings(body);
    request.log.info(
      {
        event: 'shift.settings_updated',
        actorUserId: session.user.id,
        maxCashDiscrepancyWithoutOverride: res.maxCashDiscrepancyWithoutOverride,
      },
      'Updated shift cash discrepancy threshold',
    );
    return res;
  });

  app.get('/shifts', async (request) => {
    await authorize(authService, request, 'shifts:read');
    const query = ShiftListQuerySchema.parse(request.query);
    return shiftService.listShifts(query);
  });

  app.post('/shifts/open', async (request, reply) => {
    const session = await authorize(authService, request, 'shifts:open');
    const body = OpenShiftRequestSchema.parse(request.body);
    const res = await shiftService.openShift(session, body);
    request.log.info(
      {
        event: 'shift.opened',
        organizationId: res.shift.organizationId,
        storeId: res.shift.storeId,
        shiftId: res.shift.id,
        shiftCode: res.shift.shiftCode,
        actorUserId: session.user.id,
        openingCash: res.shift.openingCash,
        openingDiscrepancy: res.shift.openingDiscrepancy,
        idempotentReplay: res.idempotentReplay,
      },
      'Opened terminal cash shift',
    );
    return reply.code(res.idempotentReplay ? 200 : 201).send(res);
  });

  app.get('/shifts/:id', async (request) => {
    await authorize(authService, request, 'shifts:read');
    const params = ShiftIdParamsSchema.parse(request.params);
    return shiftService.getShiftDetail(params.id);
  });

  app.post('/shifts/:id/handoff', async (request) => {
    const session = await authorize(authService, request, 'shifts:close');
    const params = ShiftIdParamsSchema.parse(request.params);
    const body = HandoffCashierRequestSchema.parse(request.body);
    const res = await shiftService.handoffCashier(params.id, session, body);
    request.log.info(
      {
        event: 'shift.cashier_handoff',
        shiftId: res.shift.id,
        closedSessionId: res.closedSession.id,
        activeSessionId: res.activeSession.id,
        nextCashierUserId: res.activeSession.cashierUserId,
        actorUserId: session.user.id,
        discrepancy: res.closedSession.discrepancy,
        overrideApprovedByUserId: res.closedSession.overrideApprovedByUserId,
        idempotentReplay: res.idempotentReplay,
      },
      'Completed shift cashier handoff',
    );
    return res;
  });

  app.post('/shifts/:id/close', async (request) => {
    const session = await authorize(authService, request, 'shifts:close');
    const params = ShiftIdParamsSchema.parse(request.params);
    const body = CloseShiftRequestSchema.parse(request.body);
    const res = await shiftService.closeShift(params.id, session, body);
    request.log.info(
      {
        event: 'shift.closed',
        shiftId: res.shift.id,
        closureId: res.closure.id,
        actorUserId: session.user.id,
        expectedCash: res.closure.expectedCash,
        countedCash: res.closure.countedCash,
        discrepancy: res.closure.discrepancy,
        overrideApprovedByUserId: res.closure.overrideApprovedByUserId,
        idempotentReplay: res.idempotentReplay,
      },
      'Closed terminal cash shift',
    );
    return res;
  });

  app.post('/shifts/:id/reclose', async (request) => {
    const session = await authorize(authService, request, 'shifts:reclose');
    const params = ShiftIdParamsSchema.parse(request.params);
    const body = RecloseShiftRequestSchema.parse(request.body);
    const res = await shiftService.recloseShift(params.id, session, body);
    request.log.info(
      {
        event: 'shift.reclosed',
        shiftId: res.shift.id,
        closureId: res.closure.id,
        closureSeq: res.closure.closureSeq,
        actorUserId: session.user.id,
        countedCash: res.closure.countedCash,
        discrepancy: res.closure.discrepancy,
        overrideApprovedByUserId: res.closure.overrideApprovedByUserId,
        idempotentReplay: res.idempotentReplay,
      },
      'Reclosed terminal cash shift',
    );
    return res;
  });

  app.post('/shifts/:id/cash-moves', async (request, reply) => {
    const session = await authorize(authService, request, 'shifts:cash_move');
    const params = ShiftIdParamsSchema.parse(request.params);
    const body = CreateShiftCashMoveRequestSchema.parse(request.body);
    const res = await shiftService.recordCashMove(params.id, session, body);
    request.log.info(
      {
        event: 'shift.cash_move',
        shiftId: params.id,
        cashMoveId: res.cashMove.id,
        type: res.cashMove.type,
        amountDelta: res.cashMove.amountDelta,
        expenseCategory: res.cashMove.expenseCategory,
        actorUserId: session.user.id,
        idempotentReplay: res.idempotentReplay,
      },
      'Recorded shift cash movement',
    );
    return reply.code(res.idempotentReplay ? 200 : 201).send(res);
  });

  app.post('/day-closes', async (request, reply) => {
    const session = await authorize(authService, request, 'day_close:execute');
    const body = CloseBusinessDayRequestSchema.parse(request.body);
    const res = await shiftService.closeBusinessDay(session, body);
    request.log.info(
      {
        event: 'day_close.created',
        dayCloseId: res.dayClose.id,
        businessDate: res.dayClose.businessDate,
        closeSeq: res.dayClose.closeSeq,
        shiftsCount: res.dayClose.shiftsCount,
        grossSalesTotal: res.dayClose.grossSalesTotal,
        actorUserId: session.user.id,
        idempotentReplay: res.idempotentReplay,
      },
      'Closed store business day',
    );
    return reply.code(res.idempotentReplay ? 200 : 201).send(res);
  });

  app.get('/day-closes', async (request) => {
    await authorize(authService, request, 'shifts:read');
    const query = DayCloseListQuerySchema.parse(request.query);
    return shiftService.listDayCloses(query);
  });
}
