import {
  DailySalesReportQuerySchema,
  DebtsReportQuerySchema,
  ExpiringBatchesReportQuerySchema,
  LowStockReportQuerySchema,
  MonthlySalesReportQuerySchema,
  ProfitReportQuerySchema,
} from '@mezon/contracts';
import type { HubPermission } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HubAuthService } from './auth-service.js';
import type { HubReportService } from './report-service.js';

async function authorize(
  authService: HubAuthService,
  request: FastifyRequest,
  permission: HubPermission,
) {
  const session = await authService.authenticate(request.headers.authorization);
  authService.assertPermission(session, permission);
  return session;
}

export function registerReportRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  reportService: HubReportService,
): void {
  // Daily Sales: Cashier/Manager see quantities & revenues; Owner also gets cost & profit
  app.get('/reports/sales/daily', async (request) => {
    const session = await authorize(authService, request, 'shifts:read');
    const query = DailySalesReportQuerySchema.parse(request.query);
    return reportService.getDailySales(query, session.user.role);
  });

  // Daily Sales Excel Export
  app.get('/reports/sales/daily/export', async (request, reply) => {
    const session = await authorize(authService, request, 'shifts:read');
    const query = DailySalesReportQuerySchema.parse(request.query);
    const buffer = await reportService.exportDailySales(query, session.user.role);

    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header(
        'Content-Disposition',
        `attachment; filename="daily-sales-${query.fromDate ?? 'all'}.xlsx"`,
      )
      .send(buffer);
  });

  // Monthly Sales
  app.get('/reports/sales/monthly', async (request) => {
    const session = await authorize(authService, request, 'shifts:read');
    const query = MonthlySalesReportQuerySchema.parse(request.query);
    return reportService.getMonthlySales(query, session.user.role);
  });

  // Profit Report: Strictly Owner Only!
  app.get('/reports/profit', async (request) => {
    const session = await authorize(authService, request, 'reports:profit');
    const query = ProfitReportQuerySchema.parse(request.query);
    return reportService.getProfitReport(query, session.user.role);
  });

  // Debts Report
  app.get('/reports/debts', async (request) => {
    await authorize(authService, request, 'customers:read');
    const query = DebtsReportQuerySchema.parse(request.query);
    return reportService.getDebtsReport(query);
  });

  // Debts Excel Export
  app.get('/reports/debts/export', async (request, reply) => {
    await authorize(authService, request, 'customers:read');
    const query = DebtsReportQuerySchema.parse(request.query);
    const buffer = await reportService.exportDebts(query);

    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="debts-report.xlsx"')
      .send(buffer);
  });

  // Low Stock Report
  app.get('/reports/low-stock', async (request) => {
    await authorize(authService, request, 'stock:read');
    const query = LowStockReportQuerySchema.parse(request.query);
    return reportService.getLowStock(query);
  });

  // Expiring Batches Report
  app.get('/reports/expiring-batches', async (request) => {
    await authorize(authService, request, 'stock:read');
    const query = ExpiringBatchesReportQuerySchema.parse(request.query);
    return reportService.getExpiringBatches(query);
  });
}
