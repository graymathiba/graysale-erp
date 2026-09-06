import { Agent } from '../agent.js';
import { createResult, createAuditEntry, ResultStatus } from '../message.js';

class SalesAgent extends Agent {
  constructor(store, posService) {
    super({
      name: 'SALES_AGENT',
      role: 'Sales — Customers, Orders, Quotes, Sales Analytics',
      capabilities: [
        'customer.list', 'customer.get', 'customer.create', 'customer.update', 'customer.search',
        'order.create', 'order.history', 'order.void',
        'quote.generate', 'quote.get', 'quote.list', 'quote.accept', 'quote.decline',
        'analytics.top_products', 'analytics.by_category', 'analytics.daily',
      ],
    });
    this.store = store;
    this.pos = posService;
  }

  async handle(message) {
    const { domain, payload } = message;

    switch (domain) {
      case 'customer.list': return this.listCustomers();
      case 'customer.get': return this.getCustomer(payload);
      case 'customer.create': return this.createCustomer(payload);
      case 'customer.update': return this.updateCustomer(payload);
      case 'customer.search': return this.searchCustomers(payload);
      case 'order.create': return this.createOrder(payload);
      case 'order.history': return this.orderHistory(payload);
      case 'order.void': return this.voidOrder(payload);
      case 'quote.generate': return this.generateQuote(payload);
      case 'quote.get': return this.getQuote(payload);
      case 'quote.list': return this.listQuotes(payload);
      case 'quote.accept': return this.acceptQuote(payload);
      case 'quote.decline': return this.declineQuote(payload);
      case 'analytics.top_products': return this.topProducts(payload);
      case 'analytics.by_category': return this.salesByCategory();
      case 'analytics.daily': return this.dailySummary();
      default: return createResult({ status: ResultStatus.FAILURE, error: `Unknown sales action: ${domain}` });
    }
  }

  listCustomers() {
    const rows = this.store.db.prepare('SELECT * FROM customers ORDER BY name').all();
    return createResult({
      data: rows,
      audit: [createAuditEntry(this.name, 'list_customers', `${rows.length} customers`)],
    });
  }

  getCustomer({ customerId }) {
    const row = this.store.db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    return createResult({
      data: row || null,
      audit: [createAuditEntry(this.name, 'get_customer', `id=${customerId}`)],
    });
  }

  createCustomer({ name, phone = null, email = null }) {
    const id = this.store.db.prepare(
      'INSERT INTO customers (name, phone, email) VALUES (?, ?, ?)'
    ).run(name, phone ?? null, email ?? null).lastInsertRowid;

    const customer = this.store.db.prepare('SELECT * FROM customers WHERE id = ?').get(id);

    return createResult({
      data: customer,
      audit: [createAuditEntry(this.name, 'create_customer', name)],
    });
  }

  updateCustomer({ customerId, name, phone, email }) {
    const db = this.store.db;
    const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!existing) {
      return createResult({ status: ResultStatus.FAILURE, error: 'CUSTOMER_NOT_FOUND' });
    }

    const sets = [];
    const vals = [];

    if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
    if (phone !== undefined) { sets.push('phone = ?'); vals.push(phone); }
    if (email !== undefined) { sets.push('email = ?'); vals.push(email); }

    if (sets.length === 0) {
      return createResult({ data: existing, audit: [createAuditEntry(this.name, 'update_customer', `id=${customerId} no changes`)] });
    }

    vals.push(customerId);
    db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    return createResult({
      data: updated,
      audit: [createAuditEntry(this.name, 'update_customer', `id=${customerId}`)],
    });
  }

  searchCustomers({ query }) {
    const like = `%${query}%`;
    const rows = this.store.db.prepare(
      'SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? OR email LIKE ? LIMIT 20'
    ).all(like, like, like);
    return createResult({
      data: rows,
      audit: [createAuditEntry(this.name, 'search_customers', query)],
    });
  }

  async createOrder({ customerId, items, discountCents = 0, redeemPoints = 0, paymentMethod = 'cash', cashReceivedCents }) {
    if (!this.pos) {
      return createResult({ status: ResultStatus.FAILURE, error: 'POS_SERVICE_NOT_AVAILABLE' });
    }

    const result = await this.pos.checkout({
      items: items.map(it => ({ productId: it.productId, qty: it.qty })),
      customerId: customerId ?? null,
      discountCents,
      redeemPoints,
      paymentMethod,
      cashReceivedCents: cashReceivedCents ?? null,
    });

    if (!result.ok) {
      return createResult({ status: ResultStatus.FAILURE, error: result.error });
    }

    return createResult({
      data: {
        saleId: result.saleId,
        receiptNo: result.receiptNo,
        totalCents: result.totalCents,
        subtotalCents: result.subtotalCents,
        discountCents: result.discountCents,
        taxCents: result.taxCents,
        changeCents: result.changeCents,
        loyaltyPointsEarned: result.loyaltyPointsEarned,
        lines: result.lines,
      },
      audit: [createAuditEntry(this.name, 'create_order', `receipt=${result.receiptNo} total=${result.totalCents}`)],
    });
  }

  orderHistory({ customerId, limit = 50 } = {}) {
    const db = this.store.db;
    let rows;

    if (customerId) {
      rows = db.prepare(
        `SELECT s.*, (SELECT GROUP_CONCAT(si.product_name || ' x ' || si.qty, ', ') FROM sale_items si WHERE si.sale_id = s.id) AS item_summary,
                c.name AS customer_name
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE s.customer_id = ?
         ORDER BY s.created_at DESC
         LIMIT ?`
      ).all(customerId, limit);
    } else {
      rows = db.prepare(
        `SELECT s.*, (SELECT GROUP_CONCAT(si.product_name || ' x ' || si.qty, ', ') FROM sale_items si WHERE si.sale_id = s.id) AS item_summary,
                c.name AS customer_name
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         ORDER BY s.created_at DESC
         LIMIT ?`
      ).all(limit);
    }

    return createResult({
      data: rows,
      audit: [createAuditEntry(this.name, 'order_history', `${rows.length} sales`)],
    });
  }

  voidOrder({ saleId, reason = 'Agent void' }) {
    if (!this.pos) {
      return createResult({ status: ResultStatus.FAILURE, error: 'POS_SERVICE_NOT_AVAILABLE' });
    }

    const result = this.pos.voidSale(saleId, reason);

    if (!result.ok) {
      return createResult({ status: ResultStatus.FAILURE, error: result.error });
    }

    const sale = this.store.db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);

    return createResult({
      data: {
        saleId,
        receiptNo: sale?.receipt_no,
        status: 'void',
      },
      audit: [createAuditEntry(this.name, 'void_order', `sale=${saleId}`)],
    });
  }

  generateQuote({ customerId, customerName, items, notes }) {
    const db = this.store.db;
    db.exec('BEGIN');
    try {
      const quoteNo = `QT-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

      let subtotalCents = 0;
      let taxCents = 0;
      for (const item of items) {
        const lineTotal = item.qty * item.unitPriceCents;
        subtotalCents += lineTotal;
        taxCents += Math.round(lineTotal * (item.taxRate || 0));
      }
      const totalCents = subtotalCents + taxCents;
      const validUntil = new Date(Date.now() + 30 * 86400000).toISOString();

      const res = db.prepare(
        `INSERT INTO quotes (quote_no, customer_id, customer_name, subtotal_cents, tax_cents, total_cents, status, valid_until, notes)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
      ).run(quoteNo, customerId ?? null, customerName ?? null, subtotalCents, taxCents, totalCents, validUntil, notes ?? null);

      const quoteId = res.lastInsertRowid;
      const ins = db.prepare(
        `INSERT INTO quote_items (quote_id, product_id, product_name, qty, unit_price_cents, line_total_cents, tax_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );

      for (const item of items) {
        const lineTotal = item.qty * item.unitPriceCents;
        const lineTax = Math.round(lineTotal * (item.taxRate || 0));
        ins.run(quoteId, item.productId ?? null, item.productName ?? null, item.qty, item.unitPriceCents, lineTotal, lineTax);
      }

      db.exec('COMMIT');

      const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(quoteId);
      const quoteItems = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quoteId);

      return createResult({
        data: { ...quote, items: quoteItems },
        audit: [createAuditEntry(this.name, 'generate_quote', `${quoteNo} total=${totalCents}`)],
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  getQuote({ quoteId }) {
    const db = this.store.db;
    const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(quoteId);
    if (!quote) return createResult({ status: ResultStatus.FAILURE, error: 'QUOTE_NOT_FOUND' });

    const items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quoteId);

    return createResult({
      data: { ...quote, items },
      audit: [createAuditEntry(this.name, 'get_quote', `quote=${quoteId}`)],
    });
  }

  listQuotes({ status, customerId } = {}) {
    const db = this.store.db;
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push('q.status = ?');
      params.push(status);
    }
    if (customerId) {
      conditions.push('q.customer_id = ?');
      params.push(customerId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT q.*, c.name AS customer_name
       FROM quotes q
       LEFT JOIN customers c ON c.id = q.customer_id
       ${where}
       ORDER BY q.created_at DESC`
    ).all(...params);

    return createResult({
      data: rows,
      audit: [createAuditEntry(this.name, 'list_quotes', `${rows.length} quotes`)],
    });
  }

  async acceptQuote({ quoteId }) {
    const db = this.store.db;
    const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(quoteId);
    if (!quote) return createResult({ status: ResultStatus.FAILURE, error: 'QUOTE_NOT_FOUND' });
    if (quote.status === 'accepted') return createResult({ status: ResultStatus.FAILURE, error: 'ALREADY_ACCEPTED' });
    if (quote.status === 'declined') return createResult({ status: ResultStatus.FAILURE, error: 'ALREADY_DECLINED' });
    if (!this.pos) return createResult({ status: ResultStatus.FAILURE, error: 'POS_SERVICE_NOT_AVAILABLE' });

    const quoteItems = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quoteId);
    const sellable = quoteItems.filter(qi => qi.product_id != null);
    if (sellable.length === 0) {
      return createResult({ status: ResultStatus.FAILURE, error: 'QUOTE_HAS_NO_PRODUCT_LINES' });
    }

    db.exec('BEGIN');
    try {
      // 1. Verify stock for every sellable line, exactly like a checkout.
      for (const qi of sellable) {
        const stock = this.store.getStock(qi.product_id);
        if (!stock || stock.quantity < qi.qty) {
          db.exec('ROLLBACK');
          return createResult({ status: ResultStatus.FAILURE, error: `INSUFFICIENT_STOCK:${qi.product_id}` });
        }
      }

      const subtotalCents = quote.subtotal_cents;
      const taxCents = quote.tax_cents;
      const totalCents = quote.total_cents;
      const changeCents = 0;
      const ptsEarned = this.store.pointsForCents(totalCents);
      const receiptNo = `SALE-QT-${quoteId}-${Date.now()}`;

      // 2. Insert sale + line items (quoted prices, no discounts applied).
      const saleRes = db.prepare(
        `INSERT INTO sales (receipt_no, customer_id, subtotal_cents, discount_cents, tax_cents,
           total_cents, payment_method, cash_received_cents, change_cents, loyalty_points_earned)
         VALUES (?, ?, ?, 0, ?, ?, 'quote', ?, ?, ?)`
      ).run(receiptNo, quote.customer_id, subtotalCents, taxCents, totalCents, totalCents, changeCents, ptsEarned);
      const saleId = saleRes.lastInsertRowid;

      const insItem = db.prepare(
        `INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price_cents, line_total_cents, tax_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const insMove = db.prepare(
        `INSERT INTO inventory_movements (product_id, quantity, type, note)
         VALUES (?, ?, 'SALE', ?)`
      );
      const updStock = db.prepare("UPDATE inventory SET quantity = quantity - ?, updated_at = datetime('now') WHERE product_id = ?");
      const cogsLines = [];
      for (const qi of sellable) {
        insItem.run(saleId, qi.product_id, qi.product_name, qi.qty, qi.unit_price_cents, qi.line_total_cents, qi.tax_cents);
        updStock.run(qi.qty, qi.product_id);
        insMove.run(qi.product_id, -qi.qty, `Sale ${receiptNo}`);
        cogsLines.push({ productId: qi.product_id, qty: qi.qty });
      }

      // 3. Update customer loyalty (no points redeemed).
      if (quote.customer_id) {
        db.prepare(
          `UPDATE customers SET loyalty_points = loyalty_points + ?,
            total_spent_cents = total_spent_cents + ? WHERE id = ?`
        ).run(ptsEarned, totalCents, quote.customer_id);
      }

      // 4. Post balanced double-entry journal (AR debit, revenue + tax credit).
      this.pos.postSaleJournal(db, receiptNo, {
        revenueCents: subtotalCents,
        taxCents,
        cashReceivedMoney: totalCents,
        arMode: true,
        description: `Sale ${receiptNo} (quote ${quote.quote_no})`,
      });

      // 5. Post COGS and update the daily aggregate, like a normal sale.
      this.pos.postCogs(db, receiptNo, cogsLines);
      this.pos.updateDailyAggregate(db, new Date(), totalCents, cogsLines);

      db.prepare("UPDATE quotes SET status = 'accepted', converted_at = datetime('now') WHERE id = ?").run(quoteId);

      db.exec('COMMIT');

      return createResult({
        data: { quoteId, quoteNo: quote.quote_no, saleId, receiptNo, totalCents, status: 'accepted' },
        audit: [createAuditEntry(this.name, 'accept_quote', `${quote.quote_no} -> sale ${receiptNo}`)],
      });
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      return createResult({ status: ResultStatus.FAILURE, error: e.message });
    }
  }

  declineQuote({ quoteId }) {
    const db = this.store.db;
    const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(quoteId);
    if (!quote) return createResult({ status: ResultStatus.FAILURE, error: 'QUOTE_NOT_FOUND' });
    if (quote.status === 'declined') return createResult({ status: ResultStatus.FAILURE, error: 'ALREADY_DECLINED' });

    db.prepare("UPDATE quotes SET status = 'declined' WHERE id = ?").run(quoteId);

    return createResult({
      data: { quoteId, quoteNo: quote.quote_no, status: 'declined' },
      audit: [createAuditEntry(this.name, 'decline_quote', quote.quote_no)],
    });
  }

  topProducts({ limit = 10 } = {}) {
    const rows = this.store.db.prepare(
      `SELECT product_id, product_name, SUM(qty) AS units_sold, SUM(line_total_cents) AS revenue_cents
       FROM sale_items GROUP BY product_id ORDER BY revenue_cents DESC LIMIT ?`
    ).all(limit);
    return createResult({
      data: rows,
      audit: [createAuditEntry(this.name, 'top_products', `${rows.length} products`)],
    });
  }

  salesByCategory() {
    const rows = this.store.db.prepare(
      `SELECT p.category, SUM(si.line_total_cents) AS revenue_cents, SUM(si.qty) AS units
       FROM sale_items si JOIN products p ON p.id = si.product_id GROUP BY p.category ORDER BY revenue_cents DESC`
    ).all();
    return createResult({
      data: rows,
      audit: [createAuditEntry(this.name, 'sales_by_category', '')],
    });
  }

  dailySummary() {
    const rows = this.store.db.prepare(
      'SELECT * FROM sales_by_day ORDER BY sale_date DESC LIMIT 30'
    ).all();
    return createResult({
      data: rows,
      audit: [createAuditEntry(this.name, 'daily_summary', `${rows.length} days`)],
    });
  }
}

export { SalesAgent };
