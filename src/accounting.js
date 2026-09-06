// Accounting service: chart of accounts, ledger, trial balance, P&L, balance sheet,
// AR/AP aging, period comparison, profit margins, tax summary

class AccountingService {
  constructor(store) {
    this.store = store;
  }

  // ── Chart of Accounts ────────────────────────────────────────────────

  chartOfAccounts() {
    return this.store.db.prepare('SELECT * FROM accounts ORDER BY code').all();
  }

  accountBalance(accountCode) {
    return this.store.db.prepare('SELECT * FROM accounts WHERE code = ?').get(accountCode);
  }

  // ── Ledger with optional date-range filtering ────────────────────────

  ledger(accountCode = null, { startDate, endDate } = {}) {
    const params = [];
    let where = '';

    if (accountCode) {
      where += ' AND a.code = ?';
      params.push(accountCode);
    }
    if (startDate) {
      where += ' AND date(j.posted_at) >= date(?)';
      params.push(startDate);
    }
    if (endDate) {
      where += ' AND date(j.posted_at) <= date(?)';
      params.push(endDate);
    }

    return this.store.db.prepare(
      `SELECT jl.*, j.entry_no, j.reference, j.description, j.posted_at,
              a.code AS account_code, a.name AS account_name
       FROM journal_lines jl
       JOIN journal_entries j ON j.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
       WHERE 1=1 ${where}
       ORDER BY j.posted_at DESC`
    ).all(...params);
  }

  // ── Double-entry invariant check ─────────────────────────────────────

  verifyBalanced() {
    const row = this.store.db.prepare(
      'SELECT SUM(debits_cents) AS d, SUM(credits_cents) AS c FROM journal_lines'
    ).get();
    return { debits: row.d, credits: row.c, balanced: row.d === row.c };
  }

  // ── Trial Balance ────────────────────────────────────────────────────

  trialBalance() {
    const rows = this.store.db.prepare(
      `SELECT a.code, a.name, a.type,
              SUM(jl.debits_cents) AS total_debits,
              SUM(jl.credits_cents) AS total_credits,
              (SUM(jl.debits_cents) - SUM(jl.credits_cents)) AS net
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       GROUP BY a.id ORDER BY a.code`
    ).all();
    return rows.map(r => ({ ...r, debits: r.total_debits, credits: r.total_credits }));
  }

  // ── Profit & Loss with date-range filtering ──────────────────────────

  profitAndLoss({ startDate, endDate } = {}) {
    let dateFilter = '';
    const params = [];

    if (startDate) {
      dateFilter += ' AND date(je.posted_at) >= date(?)';
      params.push(startDate);
    }
    if (endDate) {
      dateFilter += ' AND date(je.posted_at) <= date(?)';
      params.push(endDate);
    }

    const plStmt = this.store.db.prepare(
      `SELECT a.type,
              SUM(
                CASE WHEN a.type IN ('revenue', 'equity', 'liability')
                  THEN jl.credits_cents - jl.debits_cents
                  ELSE jl.debits_cents - jl.credits_cents
                END
              ) AS balance_cents
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
       WHERE 1=1 ${dateFilter}
       GROUP BY a.type`
    );
    const typeMap = Object.fromEntries(plStmt.all(...params).map(r => [r.type, r.balance_cents]));

    const revenue = typeMap.revenue ?? 0;
    const expenses = typeMap.expense ?? 0;

    const detailStmt = this.store.db.prepare(
      `SELECT a.code, a.name,
              SUM(
                CASE WHEN a.type IN ('revenue', 'equity', 'liability')
                  THEN jl.credits_cents - jl.debits_cents
                  ELSE jl.debits_cents - jl.credits_cents
                END
              ) AS balance_cents
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
       WHERE a.type IN ('revenue', 'expense') ${dateFilter}
       GROUP BY a.id ORDER BY a.code`
    );
    const details = detailStmt.all(...params);

    const cogs = details
      .filter(d => d.code === '4100')
      .reduce((s, d) => s + d.balance_cents, 0);
    const grossProfit = revenue - cogs;
    const operatingExpenses = details
      .filter(d => d.code === '4300')
      .reduce((s, d) => s + d.balance_cents, 0);

    return {
      revenue,
      cogs,
      grossProfit,
      operatingExpenses,
      netProfit: revenue - expenses,
      details,
    };
  }

  // ── Balance Sheet with date-range filtering ──────────────────────────

  balanceSheet({ startDate, endDate } = {}) {
    let dateFilter = '';
    const params = [];

    if (startDate) {
      dateFilter += ' AND date(je.posted_at) >= date(?)';
      params.push(startDate);
    }
    if (endDate) {
      dateFilter += ' AND date(je.posted_at) <= date(?)';
      params.push(endDate);
    }

    const stmt = this.store.db.prepare(
      `SELECT a.type,
              SUM(
                CASE WHEN a.type IN ('revenue', 'equity', 'liability')
                  THEN jl.credits_cents - jl.debits_cents
                  ELSE jl.debits_cents - jl.credits_cents
                END
              ) AS balance_cents
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
       WHERE 1=1 ${dateFilter}
       GROUP BY a.type`
    );
    const typeMap = Object.fromEntries(stmt.all(...params).map(r => [r.type, r.balance_cents]));

    const assets = typeMap.asset ?? 0;
    const liabilities = typeMap.liability ?? 0;
    const equityAccounts = typeMap.equity ?? 0;
    const revenue = typeMap.revenue ?? 0;
    const expenses = typeMap.expense ?? 0;
    const netIncome = revenue - expenses;
    const equity = equityAccounts + netIncome;

    return {
      assets,
      liabilities,
      equity,
      netIncome,
      balanced: assets === liabilities + equity,
      totalAssets: assets,
      totalLiabilities: liabilities,
      totalEquity: equity,
    };
  }

  // ── AR/AP Aging Buckets ──────────────────────────────────────────────

  agingBuckets() {
    const today = new Date().toISOString().slice(0, 10);

    const arRows = this.store.db.prepare(
      `SELECT i.id, i.invoice_no, i.party_name, i.total_cents, i.paid_cents,
              i.due_date, i.created_at,
              CAST(julianday(?) - julianday(i.created_at) AS INTEGER) AS days_open
       FROM invoices i
       WHERE i.type IN ('ar', 'receivable') AND i.status = 'open'
       ORDER BY days_open DESC`
    ).all(today);

    const apRows = this.store.db.prepare(
      `SELECT i.id, i.invoice_no, i.party_name, i.total_cents, i.paid_cents,
              i.due_date, i.created_at,
              CAST(julianday(?) - julianday(i.created_at) AS INTEGER) AS days_open
       FROM invoices i
       WHERE i.type IN ('ap', 'payable') AND i.status = 'open'
       ORDER BY days_open DESC`
    ).all(today);

    const bucketize = (rows) => {
      const buckets = { current: [], b30: [], b60: [], b90: [], b120plus: [] };
      for (const row of rows) {
        const d = row.days_open;
        if (d < 30) buckets.current.push(row);
        else if (d < 60) buckets.b30.push(row);
        else if (d < 90) buckets.b60.push(row);
        else if (d < 120) buckets.b90.push(row);
        else buckets.b120plus.push(row);
      }
      const totals = {};
      for (const key of Object.keys(buckets)) {
        const outstanding = buckets[key].reduce(
          (s, r) => s + (r.total_cents - r.paid_cents), 0
        );
        totals[key] = { count: buckets[key].length, outstanding_cents: outstanding };
      }
      return { buckets, totals };
    };

    return {
      accountsReceivable: bucketize(arRows),
      accountsPayable: bucketize(apRows),
    };
  }

  // ── Period P&L Comparison ────────────────────────────────────────────

  comparePnl({ periods } = {}) {
    if (!periods || !Array.isArray(periods) || periods.length === 0) {
      return { periods: [] };
    }

    const results = periods.map(p => ({
      label: p.label ?? `${p.startDate} to ${p.endDate}`,
      startDate: p.startDate,
      endDate: p.endDate,
      pnl: this.profitAndLoss({ startDate: p.startDate, endDate: p.endDate }),
    }));

    return { periods: results };
  }

  // ── Profit Margins by category and product ───────────────────────────

  profitMargins() {
    const byCategory = this.store.db.prepare(
      `SELECT p.category,
              SUM(si.line_total_cents) AS revenue_cents,
              SUM(si.qty * p.cost_cents) AS cost_cents,
              SUM(si.line_total_cents) - SUM(si.qty * p.cost_cents) AS margin_cents,
              CASE WHEN SUM(si.line_total_cents) > 0
                THEN ROUND((SUM(si.line_total_cents) - SUM(si.qty * p.cost_cents)) * 100.0
                     / SUM(si.line_total_cents), 2)
                ELSE 0
              END AS margin_pct
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       GROUP BY p.category
       ORDER BY margin_cents DESC`
    ).all();

    const byProduct = this.store.db.prepare(
      `SELECT si.product_id, si.product_name, p.category,
              SUM(si.line_total_cents) AS revenue_cents,
              SUM(si.qty * p.cost_cents) AS cost_cents,
              SUM(si.line_total_cents) - SUM(si.qty * p.cost_cents) AS margin_cents,
              CASE WHEN SUM(si.line_total_cents) > 0
                THEN ROUND((SUM(si.line_total_cents) - SUM(si.qty * p.cost_cents)) * 100.0
                     / SUM(si.line_total_cents), 2)
                ELSE 0
              END AS margin_pct
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       GROUP BY si.product_id
       ORDER BY margin_cents DESC`
    ).all();

    return { byCategory, byProduct };
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
              SUM(s.tax_cents) AS tax_collected_cents,
              COUNT(*) AS sale_count,
              SUM(s.total_cents) AS total_sales_cents
       FROM sales s
       WHERE s.status = 'complete' ${dateFilter}
       GROUP BY period
       ORDER BY period DESC`
    ).all(...params);

    const totalTax = byMonth.reduce((s, r) => s + r.tax_collected_cents, 0);

    const byCategory = this.store.db.prepare(
      `SELECT p.category,
              SUM(si.tax_cents) AS tax_cents,
              COUNT(DISTINCT si.sale_id) AS sale_count
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       JOIN sales s ON s.id = si.sale_id
       WHERE s.status = 'complete' ${dateFilter}
       GROUP BY p.category
       ORDER BY tax_cents DESC`
    ).all(...params);

    return { totalTax, byMonth, byCategory };
  }
}

export { AccountingService };
