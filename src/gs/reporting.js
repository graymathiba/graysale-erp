// Retail reporting service ported onto gs_orders/gs_order_lines + shared
// inventory/product_categories tables.

import { todayLocal } from './ids.js';

class ReportingService {
  constructor(db) {
    this.db = db;
  }

  salesSummary({ from, to, locationId } = {}) {
    const to_ = to || todayLocal();
    const from_ = from || to_;
    const rows = this.db.prepare(`
      SELECT type, COUNT(*) AS count, COALESCE(SUM(total_cents),0) AS gross,
             COALESCE(SUM(CASE WHEN status = 'VOID' THEN 0 ELSE total_cents END),0) AS net,
             COALESCE(SUM(CASE WHEN type = 'REFUND' THEN total_cents ELSE 0 END),0) AS refunds
      FROM gs_orders
      WHERE date(created_at) BETWEEN ? AND ?
      GROUP BY type
    `).all(from_, to_);
    const sales = rows.find(r => r.type === 'SALE') || { count: 0, net: 0, gross: 0 };
    const refunds = rows.find(r => r.type === 'REFUND') || { count: 0, net: 0 };
    return {
      from: from_, to: to_,
      saleCount: sales.count,
      grossSales: sales.gross,
      refunds: refunds.count,
      refundTotal: refunds.net,
      netSales: (sales.net || 0) + (refunds.net || 0),
    };
  }

  topProducts(limit = 10, { from, to } = {}) {
    return this.db.prepare(`
      SELECT l.product_id, l.product_name,
        SUM(CASE WHEN o.type = 'SALE' THEN l.qty ELSE 0 END) AS qty_sold,
        SUM(CASE WHEN o.type = 'REFUND' THEN -l.qty ELSE 0 END) AS qty_refunded,
        SUM(CASE WHEN o.type = 'SALE' THEN l.line_total_cents ELSE 0 END) AS revenue,
        SUM(CASE WHEN o.type = 'REFUND' THEN -l.line_total_cents ELSE 0 END) AS refunded
      FROM gs_order_lines l JOIN gs_orders o ON o.id = l.order_id
      WHERE o.type IN ('SALE','REFUND') AND o.status = 'PAID'
        AND date(o.created_at) BETWEEN ? AND ?
      GROUP BY l.product_id, l.product_name
      ORDER BY revenue DESC LIMIT ?
    `).all(from || '0000-01-01', to || '9999-12-31', limit);
  }

  salesByDay({ from, to } = {}) {
    return this.db.prepare(`
      SELECT date(created_at) AS day,
        COUNT(*) AS count,
        COALESCE(SUM(CASE WHEN type = 'SALE' THEN total_cents ELSE 0 END),0) AS sales,
        COALESCE(SUM(CASE WHEN type = 'REFUND' THEN total_cents ELSE 0 END),0) AS refunds
      FROM gs_orders WHERE type IN ('SALE','REFUND') AND status = 'PAID'
        AND date(created_at) BETWEEN ? AND ?
      GROUP BY day ORDER BY day
    `).all(from || '0000-01-01', to || '9999-12-31');
  }

  salesByCategory({ from, to } = {}) {
    return this.db.prepare(`
      SELECT COALESCE(c.name, 'Uncategorized') AS category,
        SUM(l.line_total_cents) AS revenue,
        SUM(l.qty) AS qty
      FROM gs_order_lines l
      JOIN gs_orders o ON o.id = l.order_id
      LEFT JOIN products p ON p.id = l.product_id
      LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE o.type = 'SALE' AND o.status = 'PAID' AND date(o.created_at) BETWEEN ? AND ?
      GROUP BY category ORDER BY revenue DESC
    `).all(from || '0000-01-01', to || '9999-12-31');
  }

  // ---- unused placeholder never called by routes ----

  cashierPerformance({ from, to } = {}) {
    return this.db.prepare(`
      SELECT u.username, u.full_name, COUNT(o.id) AS sales, COALESCE(SUM(o.total_cents),0) AS total
      FROM gs_orders o JOIN users u ON u.id = o.user_id
      WHERE o.type = 'SALE' AND o.status = 'PAID' AND date(o.created_at) BETWEEN ? AND ?
      GROUP BY u.id ORDER BY total DESC
    `).all(from || '0000-01-01', to || '9999-12-31');
  }

  deadStock(days = 30) {
    return this.db.prepare(`
      SELECT p.id, p.name, p.sku, p.barcode, COALESCE(i.quantity, 0) AS qty_on_hand,
        p.cost_cents, p.price_cents
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      WHERE p.active = 1 AND COALESCE(i.quantity, 0) > 0
        AND NOT EXISTS (
          SELECT 1 FROM gs_order_lines l JOIN gs_orders o ON o.id = l.order_id
          WHERE l.product_id = p.id AND o.type IN ('SALE','REFUND') AND date(o.created_at) >= date('now', ?)
        )
      ORDER BY p.name
    `).all(`-${Math.max(days, 1)} days`);
  }
}

export { ReportingService };