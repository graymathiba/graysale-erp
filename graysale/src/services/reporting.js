import { todayLocal } from '../lib/ids.js';
import { resolveTenantId } from '../lib/tenant.js';

export class ReportingService {
  constructor(db) {
    this.db = db;
  }

  // POS sale totals (net of refunds) between dates or for today.
  // Only settled orders count: VOID and AWAITING_PAYMENT never reach the figures.
  salesSummary({ from, to, tenantId } = {}) {
    const tenant = resolveTenantId(this.db, tenantId);
    const to_ = to || todayLocal();
    const from_ = from || to_;
    const rows = this.db
      .prepare(
        `
      SELECT type, COUNT(*) AS count, COALESCE(SUM(total_cents),0) AS gross
      FROM orders
      WHERE status = 'PAID' AND date(created_at) BETWEEN ? AND ? AND tenant_id = ?
      GROUP BY type
    `,
      )
      .all(from_, to_, tenant);
    const sales = rows.find((r) => r.type === 'SALE') || { count: 0, gross: 0 };
    const refunds = rows.find((r) => r.type === 'REFUND') || { count: 0, gross: 0 };
    const units = this.db
      .prepare(
        `
      SELECT COALESCE(SUM(CASE WHEN o.type = 'SALE' THEN l.qty ELSE -l.qty END),0) AS u
      FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE o.tenant_id = ? AND o.type IN ('SALE','REFUND') AND o.status = 'PAID' AND date(o.created_at) BETWEEN ? AND ?
    `,
      )
      .get(tenant, from_, to_);
    return {
      from: from_,
      to: to_,
      saleCount: sales.count,
      units: units.u,
      grossSales: sales.gross,
      refunds: refunds.count,
      refundTotal: refunds.gross,
      netSales: (sales.gross || 0) + (refunds.gross || 0),
    };
  }

  topProducts(limit = 10, { from, to, tenantId } = {}) {
    const tenant = resolveTenantId(this.db, tenantId);
    return this.db
      .prepare(
        `
      SELECT l.product_id, l.product_name,
        SUM(CASE WHEN o.type = 'SALE' THEN l.qty ELSE 0 END) AS qty_sold,
        SUM(CASE WHEN o.type = 'REFUND' THEN -l.qty ELSE 0 END) AS qty_refunded,
        SUM(CASE WHEN o.type = 'SALE' THEN l.line_total_cents ELSE 0 END) AS revenue,
        SUM(CASE WHEN o.type = 'REFUND' THEN -l.line_total_cents ELSE 0 END) AS refunded
      FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE o.tenant_id = ? AND o.type IN ('SALE','REFUND') AND o.status = 'PAID'
        AND date(o.created_at) BETWEEN ? AND ?
      GROUP BY l.product_id, l.product_name
      ORDER BY revenue DESC LIMIT ?
    `,
      )
      .all(tenant, from || '0000-01-01', to || '9999-12-31', limit);
  }

  salesByDay({ from, to, tenantId } = {}) {
    const tenant = resolveTenantId(this.db, tenantId);
    return this.db
      .prepare(
        `
      SELECT date(created_at) AS day,
        COUNT(*) AS count,
        COALESCE(SUM(CASE WHEN type = 'SALE' THEN total_cents ELSE 0 END),0) AS sales,
        COALESCE(SUM(CASE WHEN type = 'REFUND' THEN total_cents ELSE 0 END),0) AS refunds
      FROM orders WHERE tenant_id = ? AND type IN ('SALE','REFUND') AND status = 'PAID'
        AND date(created_at) BETWEEN ? AND ?
      GROUP BY day ORDER BY day
    `,
      )
      .all(tenant, from || '0000-01-01', to || '9999-12-31');
  }

  salesByCategory({ from, to, tenantId } = {}) {
    const tenant = resolveTenantId(this.db, tenantId);
    return this.db
      .prepare(
        `
      SELECT COALESCE(c.name, 'Uncategorized') AS category,
        SUM(l.line_total_cents) AS revenue,
        SUM(l.qty) AS qty
      FROM order_lines l
      JOIN orders o ON o.id = l.order_id
      LEFT JOIN products p ON p.id = l.product_id
      LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE o.tenant_id = ? AND o.type = 'SALE' AND o.status = 'PAID' AND date(o.created_at) BETWEEN ? AND ?
      GROUP BY category ORDER BY revenue DESC
    `,
      )
      .all(tenant, from || '0000-01-01', to || '9999-12-31');
  }

  cashierPerformance({ from, to, tenantId } = {}) {
    const tenant = resolveTenantId(this.db, tenantId);
    return this.db
      .prepare(
        `
      SELECT u.username, u.full_name, COUNT(o.id) AS sales, COALESCE(SUM(o.total_cents),0) AS total
      FROM orders o JOIN users u ON u.id = o.user_id
      WHERE o.tenant_id = ? AND o.type = 'SALE' AND o.status = 'PAID' AND date(o.created_at) BETWEEN ? AND ?
      GROUP BY u.id ORDER BY total DESC
    `,
      )
      .all(tenant, from || '0000-01-01', to || '9999-12-31');
  }

  // Products with stock but no sales movement in N days.
  deadStock(days = 30, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    return this.db
      .prepare(
        `
      SELECT p.id, p.name, p.sku, p.barcode, COALESCE(s.qty_on_hand,0) AS qty_on_hand,
        p.cost_cents, p.price_cents, p.reorder_level
      FROM products p LEFT JOIN product_stock s ON s.product_id = p.id
      WHERE p.tenant_id = ? AND p.active = 1 AND COALESCE(s.qty_on_hand,0) > 0
        AND NOT EXISTS (
          SELECT 1 FROM order_lines l JOIN orders o ON o.id = l.order_id
          WHERE l.product_id = p.id AND o.tenant_id = ? AND o.type IN ('SALE','REFUND') AND date(o.created_at) >= date('now', ?)
        )
      ORDER BY p.name
    `,
      )
      .all(tenant, tenant, `-${Math.max(days, 1)} days`);
  }

  // Real financial dashboard stats — aggregated straight from the tenant's
  // transaction tables (orders / ar_invoices / ap_bills), never hardcoded.
  dashboardStats({ from, to, tenantId } = {}) {
    const tenant = resolveTenantId(this.db, tenantId);
    const to_ = to || todayLocal();
    const from_ = from || '2020-01-01';

    // Revenue = completed SALE orders (net of refunds), within the window.
    const revenue = this.db
      .prepare(
        `
      SELECT
        COALESCE(SUM(CASE WHEN type = 'SALE' THEN total_cents ELSE 0 END), 0) AS sales,
        COUNT(CASE WHEN type = 'SALE' THEN 1 END) AS sale_count,
        COALESCE(SUM(CASE WHEN type = 'REFUND' THEN total_cents ELSE 0 END), 0) AS refund_total
      FROM orders
      WHERE tenant_id = ? AND status = 'PAID' AND type IN ('SALE','REFUND')
        AND date(created_at) BETWEEN ? AND ?
    `,
      )
      .get(tenant, from_, to_);

    // Outstanding money owed to the tenant (credit invoices + layaway balances).
    const balanceDue = this.db
      .prepare(
        `
      SELECT
        COALESCE((SELECT SUM(total_cents - paid_cents) FROM ar_invoices
          WHERE tenant_id = ? AND voided = 0 AND kind = 'INVOICE' AND status IN ('OPEN','PARTIAL')), 0)
        + COALESCE((SELECT SUM(total_cents - paid_cents) FROM orders
          WHERE tenant_id = ? AND type = 'LAYAWAY' AND status IN ('OPEN','PARTIAL')), 0) AS due
    `,
      )
      .get(tenant, tenant).due;

    // What the tenant still owes suppliers.
    const payable = this.db
      .prepare(
        `
      SELECT COALESCE(SUM(total_cents - paid_cents), 0) AS due
      FROM ap_bills WHERE tenant_id = ? AND voided = 0 AND status IN ('OPEN','PARTIAL')
    `,
      )
      .get(tenant).due;

    // Cash / mobile-money received on POS sales, from the order meta payment splits.
    // EcoCash is recorded alongside MOBILE as mobile-money; both roll up to ecoCashTotal.
    const methods = this.db
      .prepare(
        `
      SELECT
        COALESCE(SUM(json_extract(meta, '$.payments.CASH')), 0) AS cashTotal,
        COALESCE(SUM(json_extract(meta, '$.payments.MOBILE')), 0) AS mobileTotal,
        COALESCE(SUM(json_extract(meta, '$.payments.ECOCASH')), 0) AS ecoCashTotal
      FROM orders WHERE tenant_id = ? AND status = 'PAID' AND type = 'SALE'
        AND date(created_at) BETWEEN ? AND ?
    `,
      )
      .get(tenant, from_, to_);

    // Low-stock products for the tenant.
    const lowStockRows = this.db
      .prepare(
        `
      SELECT COUNT(*) AS n FROM products p
      LEFT JOIN product_stock s ON s.product_id = p.id
      WHERE p.tenant_id = ? AND p.active = 1
        AND (COALESCE(s.qty_on_hand,0) - COALESCE(s.qty_reserved,0)) <= p.reorder_level
    `,
      )
      .get(tenant);

    return {
      tenantId: tenant,
      totalRevenue: (revenue.sales || 0) - (revenue.refund_total || 0),
      grossSales: revenue.sales || 0,
      refunds: revenue.refund_total || 0,
      totalSalesCount: revenue.sale_count || 0,
      totalBalanceDue: balanceDue || 0,
      totalPayable: payable || 0,
      cashTotal: methods.cashTotal || 0,
      mobileTotal: methods.mobileTotal || 0,
      ecoCashTotal: (methods.ecoCashTotal || 0) + (methods.mobileTotal || 0),
      lowStockCount: lowStockRows.n || 0,
      from: from_,
      to: to_,
    };
  }
}
