// Sales reporting and the two dashboards (lightweight rollup + SQL stats).

import { localDate, todayLocal } from '../../lib/ids.js';

export function registerReports({ route, services: S, NumID }) {
  const { reports, catalog } = S;

  route('GET', '/reports/summary', null, (ctx) =>
    ctx.json(reports.salesSummary({ from: ctx.query.from, to: ctx.query.to, tenantId: ctx.tenantId })),
  );
  route('GET', '/reports/top-products', null, (ctx) =>
    ctx.json(
      reports.topProducts(NumID(ctx.query.limit, 10), {
        from: ctx.query.from,
        to: ctx.query.to,
        tenantId: ctx.tenantId,
      }),
    ),
  );
  route('GET', '/reports/by-day', null, (ctx) =>
    ctx.json(reports.salesByDay({ from: ctx.query.from, to: ctx.query.to, tenantId: ctx.tenantId })),
  );
  route('GET', '/reports/by-category', null, (ctx) =>
    ctx.json(reports.salesByCategory({ from: ctx.query.from, to: ctx.query.to, tenantId: ctx.tenantId })),
  );
  route('GET', '/reports/cashiers', null, (ctx) =>
    ctx.json(reports.cashierPerformance({ from: ctx.query.from, to: ctx.query.to, tenantId: ctx.tenantId })),
  );
  route('GET', '/reports/dead-stock', null, (ctx) =>
    ctx.json(reports.deadStock(NumID(ctx.query.days, 30), ctx.tenantId)),
  );
  route('GET', '/dashboard', null, (ctx) =>
    ctx.json({
      today: reports.salesSummary({ tenantId: ctx.tenantId }),
      byDay: reports.salesByDay({
        from: localDate(new Date(Date.now() - 6 * 864e5)),
        to: todayLocal(),
        tenantId: ctx.tenantId,
      }),
      lowStock: catalog.lowStock(ctx.tenantId).slice(0, 8),
    }),
  );

  // Real financial dashboard stats — tenant-scoped SQL aggregation.
  route('GET', '/dashboard/stats', null, async (ctx) =>
    ctx.json(reports.dashboardStats({ from: ctx.query.from, to: ctx.query.to, tenantId: ctx.tenantId })),
  );
}
