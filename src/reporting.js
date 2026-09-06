// Reporting service: daily sales, top products, dashboards, margins,
// tax summary, employee productivity, inventory movements

class ReportingService {
  constructor(store) {
    this.store = store;
  }

  // ── Daily Summary with date-range filtering ──────────────────────────

  dailySummary({ startDate, endDate } = {}) {
    let where = '';
    const params = [];

    if (startDate) {
      where += ' AND sale_date >= date(?)';
      params.push(startDate);
    }
    if (endDate) {
      where += ' AND sale_date <= date(?)';
      params.push(endDate);
    }

    const limit = (!startDate && !endDate) ? ' LIMIT 30' : '';

    return this.store.db.prepare(
      `SELECT * FROM sales_by_day WHERE 1=1 ${where} ORDER BY sale_date DESC${limit}`
    ).all(...params);
  }

  // ── Today Stats (unchanged pattern) ──────────────────────────────────

  todayStats() {
    const day = new Date().toISOString().slice(0, 10);
    const row = this.store.db.prepare('SELECT * FROM sales_by_day WHERE sale_date = ?').get(day);
    const recent = this.store.db.prepare('SELECT * FROM sales ORDER BY created_at DESC LIMIT 10').all();
    return {
      today: row ?? { sale_date: day, count: 0, revenue_cents: 0, cost_cents: 0, profit_cents: 0 },
      recentSales: recent,
    };
  }

  // ── Top Products with date-range filtering ───────────────────────────

  topProducts(limit = 10, { startDate, endDate } = {}) {
    let dateFilter = '';
    const params = [];

    if (startDate) {
      dateFilter += ' AND date(s.created_at) >= date(?)';
      params.push(startDate);
    }
    if (endDate) {
      dateFilter += ' AND date(s.created_at) <= date(?)';
      params.push(endDate);
    }

    params.push(limit);

    return this.store.db.prepare(
      `SELECT si.product_id, si.product_name,
              SUM(si.qty) AS units_sold,
              SUM(si.line_total_cents) AS revenue_cents,
              COUNT(DISTINCT si.sale_id) AS sale_count
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       WHERE s.status = 'complete' ${dateFilter}
       GROUP BY si.product_id
       ORDER BY revenue_cents DESC
       LIMIT ?`
    ).all(...params);
  }

  // ── Sales by Category with date-range filtering ──────────────────────

  salesByCategory({ startDate, endDate } = {}) {
    let dateFilter = '';
    const params = [];

    if (startDate) {
      dateFilter += ' AND date(s.created_at) >= date(?)';
      params.push(startDate);
    }
    if (endDate) {
      dateFilter += ' AND date(s.created_at) <= date(?)';
      params.push(endDate);
    }

    return this.store.db.prepare(
      `SELECT p.category,
              SUM(si.line_total_cents) AS revenue_cents,
              SUM(si.qty) AS units,
              COUNT(DISTINCT si.sale_id) AS sale_count
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       JOIN sales s ON s.id = si.sale_id
       WHERE s.status = 'complete' ${dateFilter}
       GROUP BY p.category
       ORDER BY revenue_cents DESC`
    ).all(...params);
  }

  // ── Sales History with date-range filtering + pagination ─────────────

  salesHistory({ startDate, endDate, page, pageSize } = {}) {
    const pSize = pageSize || 50;
    const pg = page || 1;
    const offset = (pg - 1) * pSize;

    let dateFilter = '';
    const params = [];
    const countParams = [];

    if (startDate) {
      dateFilter += ' AND date(s.created_at) >= date(?)';
      params.push(startDate);
      countParams.push(startDate);
    }
    if (endDate) {
      dateFilter += ' AND date(s.created_at) <= date(?)';
      params.push(endDate);
      countParams.push(endDate);
    }

    const totalRow = this.store.db.prepare(
      `SELECT COUNT(*) AS total FROM sales s WHERE 1=1${dateFilter}`
    ).get(...countParams);

    const rows = this.store.db.prepare(
      `SELECT s.*,
              (SELECT GROUP_CONCAT(si.product_name || ' x ' || si.qty, ', ')
               FROM sale_items si WHERE si.sale_id = s.id) AS item_summary,
              c.name AS customer_name
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE 1=1 ${dateFilter}
       ORDER BY s.created_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, pSize, offset);

    return {
      data: rows,
      pagination: {
        page: pg,
        pageSize: pSize,
        total: totalRow.total,
        totalPages: Math.ceil(totalRow.total / pSize),
      },
    };
  }

  // ── Product Margins ──────────────────────────────────────────────────

  productMargins() {
    return this.store.db.prepare(
      `SELECT si.product_id, si.product_name, p.category, p.sku,
              SUM(si.qty) AS units_sold,
              SUM(si.line_total_cents) AS revenue_cents,
              SUM(si.qty * p.cost_cents) AS cost_cents,
              SUM(si.line_total_cents) - SUM(si.qty * p.cost_cents) AS profit_cents,
              CASE WHEN SUM(si.line_total_cents) > 0
                THEN ROUND((SUM(si.line_total_cents) - SUM(si.qty * p.cost_cents)) * 100.0
                     / SUM(si.line_total_cents), 2)
                ELSE 0
              END AS margin_pct
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       GROUP BY si.product_id
       ORDER BY profit_cents DESC`
    ).all();
  }

  // ── Tax Summary by period ────────────────────────────────────────────

  taxSummary({ startDate, endDate } = {}) {
    let dateFilter = '';
    const params = [];

    if (startDate) {
      dateFilter += ' AND date(s.created_at) >= date(?)';
      params.push(startDate);
    }
    if (endDate) {
      dateFilter += ' AND date(s.created_at) <= date(?)';
      params.push(endDate);
    }

    const byMonth = this.store.db.prepare(
      `SELECT strftime('%Y-%m', s.created_at) AS period,
              SUM(s.tax_cents) AS tax_cents,
              COUNT(*) AS sale_count,
              SUM(s.total_cents) AS total_cents
       FROM sales s
       WHERE s.status = 'complete' ${dateFilter}
       GROUP BY period
       ORDER BY period DESC`
    ).all(...params);

    const totalTax = byMonth.reduce((s, r) => s + r.tax_cents, 0);

    return { totalTax, byMonth };
  }

  // ── Employee / Cashier Productivity ──────────────────────────────────

  cashierStats({ startDate, endDate } = {}) {
    // The sales table does not track user_id, so this aggregates all sales.
    // When user_id tracking is added to sales, update this query to GROUP BY s.user_id.
    let dateFilter = '';
    const params = [];

    if (startDate) {
      dateFilter += ' AND date(s.created_at) >= date(?)';
      params.push(startDate);
    }
    if (endDate) {
      dateFilter += ' AND date(s.created_at) <= date(?)';
      params.push(endDate);
    }

    const row = this.store.db.prepare(
      `SELECT COUNT(*) AS sales_count,
              SUM(s.total_cents) AS total_revenue_cents,
              ROUND(AVG(s.total_cents)) AS avg_sale_cents,
              MIN(s.total_cents) AS min_sale_cents,
              MAX(s.total_cents) AS max_sale_cents
       FROM sales s
       WHERE s.status = 'complete' ${dateFilter}`
    ).get(...params);

    return [row];
  }

  // ── Inventory Movements with date filtering ──────────────────────────

  inventoryMovements(productId = null, { startDate, endDate } = {}) {
    const params = [];
    let productFilter = '';
    let dateFilter = '';

    if (productId) {
      productFilter = ' AND im.product_id = ?';
      params.push(productId);
    }
    if (startDate) {
      dateFilter += ' AND date(im.created_at) >= date(?)';
      params.push(startDate);
    }
    if (endDate) {
      dateFilter += ' AND date(im.created_at) <= date(?)';
      params.push(endDate);
    }

    const limit = (!productId && !startDate && !endDate) ? ' LIMIT 200' : '';

    return this.store.db.prepare(
      `SELECT im.*, im.quantity AS qty, p.name AS product_name, p.sku
       FROM inventory_movements im
       JOIN products p ON p.id = im.product_id
       WHERE 1=1 ${productFilter}${dateFilter}
       ORDER BY im.created_at DESC${limit}`
    ).all(...params);
  }
}

export { ReportingService };
