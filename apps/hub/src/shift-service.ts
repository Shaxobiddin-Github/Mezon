import type {
  CloseBusinessDayRequestDto,
  CloseBusinessDayResponseDto,
  CloseShiftRequestDto,
  CloseShiftResponseDto,
  CreateShiftCashMoveRequestDto,
  CurrentShiftResponseDto,
  DayCloseDto,
  DayCloseListQueryDto,
  DayCloseListResponseDto,
  HandoffCashierRequestDto,
  HandoffCashierResponseDto,
  LoginRequestDto,
  OpenShiftRequestDto,
  OpenShiftResponseDto,
  RecloseShiftRequestDto,
  ShiftCashMoveResponseDto,
  ShiftCashierSessionDto,
  ShiftClosureDto,
  ShiftDetailResponseDto,
  ShiftDto,
  ShiftListQueryDto,
  ShiftListResponseDto,
  UpdateShiftSettingsRequestDto,
  UpdateShiftSettingsResponseDto,
} from '@mezon/contracts';
import type {
  AuthenticatedSessionSnapshot,
  SqliteShiftStore,
  StoredDayCloseRecord,
  StoredShiftCashierSessionRecord,
  StoredShiftClosureRecord,
  StoredShiftRecord,
} from '@mezon/db-local';
import { type CashDenominationCount, type UuidV7, moneyFromTiyin } from '@mezon/domain';
import type { HubAuthService } from './auth-service.js';
import { toCashMoveDto } from './customer-service.js';

function toCashierSessionDto(sess: StoredShiftCashierSessionRecord): ShiftCashierSessionDto {
  return {
    id: sess.id,
    shiftId: sess.shiftId,
    sessionSeq: sess.sessionSeq,
    cashierUserId: sess.cashierUserId,
    status: sess.status,
    openingFloat: sess.openingFloat.toString(),
    expectedCash: sess.expectedCash !== null ? sess.expectedCash.toString() : null,
    countedCash: sess.countedCash !== null ? sess.countedCash.toString() : null,
    discrepancy: sess.discrepancy !== null ? sess.discrepancy.toString() : null,
    discrepancyReason: sess.discrepancyReason,
    denominationsJson: sess.denominationsJson,
    overrideApprovedByUserId: sess.overrideApprovedByUserId,
    handedOffByUserId: sess.handedOffByUserId,
    note: sess.note,
    startedAtMs: sess.startedAtMs.toString(),
    endedAtMs: sess.endedAtMs !== null ? sess.endedAtMs.toString() : null,
  };
}

function toShiftDto(shift: StoredShiftRecord): ShiftDto {
  return {
    id: shift.id,
    organizationId: shift.organizationId,
    storeId: shift.storeId,
    deviceId: shift.deviceId,
    shiftNo: shift.shiftNo.toString(),
    shiftCode: shift.shiftCode,
    status: shift.status,
    openedByUserId: shift.openedByUserId,
    closedByUserId: shift.closedByUserId,
    openingCash: shift.openingCash.toString(),
    previousCloseCash: shift.previousCloseCash !== null ? shift.previousCloseCash.toString() : null,
    openingDiscrepancy: shift.openingDiscrepancy.toString(),
    openingDiscrepancyReason: shift.openingDiscrepancyReason,
    openingNote: shift.openingNote,
    closingNote: shift.closingNote,
    openedAtMs: shift.openedAtMs.toString(),
    closedAtMs: shift.closedAtMs !== null ? shift.closedAtMs.toString() : null,
    activeCashierSession:
      shift.activeCashierSession !== null ? toCashierSessionDto(shift.activeCashierSession) : null,
    cashierSessions: shift.cashierSessions.map(toCashierSessionDto),
  };
}

function toShiftClosureDto(closure: StoredShiftClosureRecord): ShiftClosureDto {
  return {
    id: closure.id,
    shiftId: closure.shiftId,
    closureSeq: closure.closureSeq,
    isReclose: closure.isReclose,
    reason: closure.reason,
    closedByUserId: closure.closedByUserId,
    overrideApprovedByUserId: closure.overrideApprovedByUserId,
    expectedCash: closure.expectedCash.toString(),
    countedCash: closure.countedCash.toString(),
    discrepancy: closure.discrepancy.toString(),
    denominationsJson: closure.denominationsJson,
    salesCount: closure.salesCount,
    returnsCount: closure.returnsCount,
    voidsCount: closure.voidsCount,
    grossSalesTotal: closure.grossSalesTotal.toString(),
    returnsTotal: closure.returnsTotal.toString(),
    netSalesTotal: closure.netSalesTotal.toString(),
    orderAdvanceCashTotal: closure.orderAdvanceCashTotal.toString(),
    orderAdvanceNonCashTotal: closure.orderAdvanceNonCashTotal.toString(),
    orderAdvanceRefundTotal: closure.orderAdvanceRefundTotal.toString(),
    createdAtMs: closure.createdAtMs.toString(),
    methodTotals: closure.methodTotals.map((m) => ({
      method: m.method,
      salesAmount: m.salesAmount.toString(),
      returnsAmount: m.returnsAmount.toString(),
      netAmount: m.netAmount.toString(),
    })),
    cashiers: closure.cashiers.map((c) => ({
      sessionId: c.sessionId,
      cashierUserId: c.cashierUserId,
      cashierUsername: c.cashierUsername,
      cashierFullName: c.cashierFullName,
      sessionSeq: c.sessionSeq,
      openingFloat: c.openingFloat.toString(),
      expectedCash: c.expectedCash.toString(),
      countedCash: c.countedCash.toString(),
      discrepancy: c.discrepancy.toString(),
      salesCount: c.salesCount,
      returnsCount: c.returnsCount,
      salesTotal: c.salesTotal.toString(),
      returnsTotal: c.returnsTotal.toString(),
      cashInTotal: c.cashInTotal.toString(),
      cashOutTotal: c.cashOutTotal.toString(),
    })),
  };
}

function toDayCloseDto(dc: StoredDayCloseRecord): DayCloseDto {
  return {
    id: dc.id,
    organizationId: dc.organizationId,
    storeId: dc.storeId,
    businessDate: dc.businessDate,
    closeSeq: dc.closeSeq,
    closeCode: dc.closeCode,
    closedByUserId: dc.closedByUserId,
    note: dc.note,
    shiftsCount: dc.shiftsCount,
    salesCount: dc.salesCount,
    returnsCount: dc.returnsCount,
    voidsCount: dc.voidsCount,
    grossSalesTotal: dc.grossSalesTotal.toString(),
    returnsTotal: dc.returnsTotal.toString(),
    netSalesTotal: dc.netSalesTotal.toString(),
    expectedCashTotal: dc.expectedCashTotal.toString(),
    countedCashTotal: dc.countedCashTotal.toString(),
    discrepancyTotal: dc.discrepancyTotal.toString(),
    methodTotals: dc.methodTotals.map((m) => ({
      method: m.method,
      salesAmount: m.salesAmount.toString(),
      returnsAmount: m.returnsAmount.toString(),
      netAmount: m.netAmount.toString(),
    })),
    fiscalStatus: dc.fiscalStatus,
    fiscalReportNo: dc.fiscalReportNo,
    isStale: dc.isStale,
    createdAtMs: dc.createdAtMs.toString(),
  };
}

function mapDenominations(
  raw: readonly { readonly nominal: string; readonly count: number }[] | undefined,
): readonly CashDenominationCount[] | undefined {
  if (!raw) {
    return undefined;
  }
  return raw.map((d) => ({
    nominal: moneyFromTiyin(BigInt(d.nominal)),
    count: d.count,
  }));
}

export class HubShiftService {
  constructor(
    private readonly store: SqliteShiftStore,
    private readonly authService: HubAuthService,
  ) {}

  private async resolveOptionalOverride(
    override: LoginRequestDto | undefined,
  ): Promise<UuidV7 | null> {
    if (override === undefined) {
      return null;
    }
    const supervisor = await this.authService.verifySupervisorPin(override);
    return supervisor.id;
  }

  async getCurrentShift(): Promise<CurrentShiftResponseDto> {
    const res = await this.store.getCurrentShift();
    return {
      shift: res.shift !== null ? toShiftDto(res.shift) : null,
      drawerCashBalance: res.drawerCashBalance.toString(),
      maxCashDiscrepancyWithoutOverride: res.maxCashDiscrepancyWithoutOverride.toString(),
    };
  }

  async listShifts(query: ShiftListQueryDto): Promise<ShiftListResponseDto> {
    const res = await this.store.listShifts({
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.deviceId !== undefined ? { deviceId: query.deviceId } : {}),
      ...(query.fromDate !== undefined ? { fromDate: query.fromDate } : {}),
      ...(query.toDate !== undefined ? { toDate: query.toDate } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
    return {
      shifts: res.shifts.map(toShiftDto),
      total: res.total,
    };
  }

  async getShiftDetail(shiftId: UuidV7): Promise<ShiftDetailResponseDto> {
    const res = await this.store.getShiftDetail(shiftId);
    return {
      shift: toShiftDto(res.shift),
      closures: res.closures.map(toShiftClosureDto),
      cashMoves: res.cashMoves.map(toCashMoveDto),
    };
  }

  async openShift(
    session: AuthenticatedSessionSnapshot,
    body: OpenShiftRequestDto,
  ): Promise<OpenShiftResponseDto> {
    const res = await this.store.openShift({
      actorUserId: session.user.id,
      clientRequestId: body.clientRequestId,
      openingCash: moneyFromTiyin(BigInt(body.openingCash)),
      ...(body.denominations !== undefined
        ? { denominations: mapDenominations(body.denominations) }
        : {}),
      ...(body.openingDiscrepancyReason !== undefined
        ? { openingDiscrepancyReason: body.openingDiscrepancyReason }
        : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
    });
    return {
      shift: toShiftDto(res.shift),
      drawerCashBalance: res.drawerCashBalance.toString(),
      idempotentReplay: res.idempotentReplay,
    };
  }

  async handoffCashier(
    shiftId: UuidV7,
    session: AuthenticatedSessionSnapshot,
    body: HandoffCashierRequestDto,
  ): Promise<HandoffCashierResponseDto> {
    const overrideApprovedByUserId = await this.resolveOptionalOverride(body.override);
    const res = await this.store.handoffCashier({
      shiftId,
      actorUserId: session.user.id,
      nextCashierUserId: body.nextCashierUserId,
      clientRequestId: body.clientRequestId,
      countedCash: moneyFromTiyin(BigInt(body.countedCash)),
      ...(body.denominations !== undefined
        ? { denominations: mapDenominations(body.denominations) }
        : {}),
      ...(body.discrepancyReason !== undefined
        ? { discrepancyReason: body.discrepancyReason }
        : {}),
      overrideApprovedByUserId,
      ...(body.note !== undefined ? { note: body.note } : {}),
    });
    return {
      shift: toShiftDto(res.shift),
      closedSession: toCashierSessionDto(res.closedSession),
      activeSession: toCashierSessionDto(res.activeSession),
      drawerCashBalance: res.drawerCashBalance.toString(),
      idempotentReplay: res.idempotentReplay,
    };
  }

  async closeShift(
    shiftId: UuidV7,
    session: AuthenticatedSessionSnapshot,
    body: CloseShiftRequestDto,
  ): Promise<CloseShiftResponseDto> {
    const overrideApprovedByUserId = await this.resolveOptionalOverride(body.override);
    const res = await this.store.closeShift({
      shiftId,
      actorUserId: session.user.id,
      clientRequestId: body.clientRequestId,
      countedCash: moneyFromTiyin(BigInt(body.countedCash)),
      ...(body.denominations !== undefined
        ? { denominations: mapDenominations(body.denominations) }
        : {}),
      ...(body.discrepancyReason !== undefined
        ? { discrepancyReason: body.discrepancyReason }
        : {}),
      overrideApprovedByUserId,
      ...(body.note !== undefined ? { note: body.note } : {}),
    });
    return {
      shift: toShiftDto(res.shift),
      closure: toShiftClosureDto(res.closure),
      drawerCashBalance: res.drawerCashBalance.toString(),
      idempotentReplay: res.idempotentReplay,
    };
  }

  async recloseShift(
    shiftId: UuidV7,
    session: AuthenticatedSessionSnapshot,
    body: RecloseShiftRequestDto,
  ): Promise<CloseShiftResponseDto> {
    const overrideApprovedByUserId = await this.resolveOptionalOverride(body.override);
    const res = await this.store.recloseShift({
      shiftId,
      actorUserId: session.user.id,
      clientRequestId: body.clientRequestId,
      countedCash: moneyFromTiyin(BigInt(body.countedCash)),
      ...(body.denominations !== undefined
        ? { denominations: mapDenominations(body.denominations) }
        : {}),
      reason: body.reason,
      overrideApprovedByUserId,
    });
    return {
      shift: toShiftDto(res.shift),
      closure: toShiftClosureDto(res.closure),
      drawerCashBalance: res.drawerCashBalance.toString(),
      idempotentReplay: res.idempotentReplay,
    };
  }

  async recordCashMove(
    shiftId: UuidV7,
    session: AuthenticatedSessionSnapshot,
    body: CreateShiftCashMoveRequestDto,
  ): Promise<ShiftCashMoveResponseDto> {
    const res = await this.store.recordShiftCashMove({
      shiftId,
      actorUserId: session.user.id,
      clientRequestId: body.clientRequestId,
      type: body.type,
      amount: moneyFromTiyin(BigInt(body.amount)),
      reason: body.reason,
      ...(body.expenseCategory !== undefined ? { expenseCategory: body.expenseCategory } : {}),
    });
    return {
      cashMove: toCashMoveDto(res.cashMove),
      drawerCashBalance: res.drawerCashBalance.toString(),
      idempotentReplay: res.idempotentReplay,
    };
  }

  async closeBusinessDay(
    session: AuthenticatedSessionSnapshot,
    body: CloseBusinessDayRequestDto,
  ): Promise<CloseBusinessDayResponseDto> {
    const res = await this.store.closeBusinessDay({
      actorUserId: session.user.id,
      clientRequestId: body.clientRequestId,
      businessDate: body.businessDate,
      ...(body.note !== undefined ? { note: body.note } : {}),
    });
    return {
      dayClose: toDayCloseDto(res.dayClose),
      idempotentReplay: res.idempotentReplay,
    };
  }

  async listDayCloses(query: DayCloseListQueryDto): Promise<DayCloseListResponseDto> {
    const res = await this.store.listDayCloses({
      ...(query.businessDate !== undefined ? { businessDate: query.businessDate } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
    return {
      dayCloses: res.dayCloses.map(toDayCloseDto),
      total: res.total,
    };
  }

  async updateSettings(
    body: UpdateShiftSettingsRequestDto,
  ): Promise<UpdateShiftSettingsResponseDto> {
    const val = await this.store.updateCashDiscrepancyThreshold(
      moneyFromTiyin(BigInt(body.maxCashDiscrepancyWithoutOverride)),
    );
    return {
      maxCashDiscrepancyWithoutOverride: val.toString(),
    };
  }
}
