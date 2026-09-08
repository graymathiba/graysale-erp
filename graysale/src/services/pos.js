import { tx, nextDoc } from '../db/database.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { taxOn } from '../lib/money.js';
import { resolveTenantId } from '../lib/tenant.js';

const METHODS = new Set(['CASH', 'CARD', 'MOBILE', 'ECOCASH', 'BANK', 'CREDIT']);

const cashTarget = (method) => (method === 'CASH' ? '1000' : '1010'); // CARD/MOBILE/BANK -> Bank

export class PosService {
  constructor({ db, catalog, accounting, invoicing, auth }) {
    this.db = db;
    this.catalog = catalog;
    this.acct = accounting;
    this.invoicing = invoicing;
    this.auth = auth;
  }

  resolveProduct(ref) {
    return this.catalog.resolveProduct(ref);
  }

  // Normalize a raw item into a priced line. Returns { product, qty, unit, lineGross, lineDiscount, tax, lineTotal }.
  buildLine(item) {
    const qty = Math.round(Number(item.qty));
    if (!Number.isInteger(qty) || qty < 1) throw badRequest('QTY_MUST_BE_POSITIVE_INTEGER');
    const product = this.resolveProduct(item.productId ?? item.sku ?? item.barcode ?? item.ref);
    if (!product.active) throw conflict(`PRODUCT_INACTIVE: ${product.name}`);

    // UOM conversion: if a UOM name is provided, adjust qty and price
    let effectiveQty = qty;
    let unit = Math.round(Number(item.unitPriceCents ?? item.priceCents));
    if (item.uomName && product.uom?.length) {
      const uom = product.uom.find((u) => u.uom_name === item.uomName);
      if (uom) {
        effectiveQty = qty * uom.conversion_factor;
        if (uom.price_override_cents != null) unit = uom.price_override_cents;
      }
    }

    // Tiered pricing: resolve price from tier if not explicitly set
    if (!item.unitPriceCents && !item.priceCents) {
      unit = this.catalog.resolvePrice(product, effectiveQty, item.tierName || null);
    }
    if (unit < 0) throw badRequest('PRICE_NEGATIVE');

    // Bundle decomposition: expand a bundle product into its components
    if (product.is_bundle) {
      const components = this.catalog.decomposeBundle(product.id, 1);
      return {
        product,
        qty: effectiveQty,
        unit_cents: unit,
        line_gross: effectiveQty * unit,
        line_discount: item.lineDiscountCents != null
          ? Math.round(Number(item.lineDiscountCents))
          : Math.round(((effectiveQty * unit) * (item.discountPercent ?? 0)) / 100),
        tax_cents: 0,
        line_total: 0,
        bundle_components: components.map((c) => ({ ...c, qty: c.qty * effectiveQty })),
      };
    }

    const lineGross = effectiveQty * unit;
    const lineDiscount = item.lineDiscountCents != null
      ? Math.round(Number(item.lineDiscountCents))
      : Math.round((lineGross * (item.discountPercent ?? 0)) / 100);
    const tax = taxOn(lineGross - lineDiscount, product.tax_rate_bps ?? 0);
    return {
      product,
      qty: effectiveQty,
      unit_cents: unit,
      line_gross: lineGross,
      line_discount: lineDiscount,
      tax_cents: tax,
      line_total: lineGross - lineDiscount + tax,
    };
  }

  _totals(lines, orderDiscountPercent = 0) {
    const subtotal = lines.reduce((s, l) => s + l.line_gross, 0);
    let discount = lines.reduce((s, l) => s + l.line_discount, 0);
    if (orderDiscountPercent) {
      discount += Math.round(((subtotal - discount) * orderDiscountPercent) / 100);
    }
    const net = subtotal - discount;
    let tax;
    if (discount === 0 || net === subtotal) {
      tax = lines.reduce((s, l) => s + l.tax_cents, 0);
    } else {
      // Order-level discount reduces the taxable base: recompute each line's
      // tax on its discounted share so the tax liability matches the charged amount.
      tax = 0;
      for (const l of lines) {
        if (l.line_gross === 0) continue;
        const portion = Math.round((l.line_gross * 1e6) / subtotal); // basis points of line share
        const lineNet = l.line_gross - l.line_discount - Math.round((discount * portion) / 1e6);
        tax += Math.round((lineNet * (l.product.tax_rate_bps ?? 0)) / 10000);
      }
    }
    const total = net + tax;
    return { subtotal, discount, tax, total };
  }

  _validatePayments(payments) {
    if (!Array.isArray(payments) || payments.length === 0) throw badRequest('PAYMENTS_REQUIRED');
    let cashInput = 0;
    let credited = 0;
    const splits = {};
    for (const p of payments) {
      if (!METHODS.has(p.method)) throw badRequest(`INVALID_PAYMENT_METHOD: ${p.method}`);
      const amount = Math.round(Number(p.amountCents ?? p.amount));
      if (amount < 0) throw badRequest('NEGATIVE_PAYMENT');
      splits[p.method] = (splits[p.method] || 0) + amount;
      if (p.method === 'CREDIT') credited += amount; else cashInput += amount;
    }
    return { splits, cashInput, credited };
  }

  _applyStock(lines, sign, type, refType, refId, userId) {
    for (const l of lines) {
      // Bundle products decompose into their components for stock purposes.
      if (l.product.is_bundle && l.bundle_components) {
        for (const c of l.bundle_components) {
          this.catalog.move({
            productId: c.productId, qty: sign * c.qty, type, refType, refId, note: refId ? `${refType}#${refId}` : '', userId,
          });
        }
        continue;
      }
      this.catalog.move({
        productId: l.product.id, qty: sign * l.qty, type, refType, refId, note: refId ? `${refType}#${refId}` : '', userId,
      });
    }
  }

  getOrder(id, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const o = this.db.prepare('SELECT * FROM orders WHERE id = ? AND tenant_id = ?').get(id, tenant);
    if (!o) throw notFound('ORDER_NOT_FOUND');
    o.lines = this.db.prepare('SELECT * FROM order_lines WHERE order_id = ?').all(id);
    o.invoices = this.db.prepare('SELECT doc_no, kind, total_cents, paid_cents, status FROM ar_invoices WHERE order_id = ?').all(id);
    return o;
  }

  _insertOrder({ type, status, lines, totals, customerId, user, locationId, note, meta, paidCents }) {
    const docNo = nextDoc(this.db, type === 'REFUND' ? 'RFD' : type);
    const { lastInsertRowid } = this.db.prepare(`
      INSERT INTO orders (doc_no, type, status, customer_id, user_id, location_id, subtotal_cents, discount_cents, tax_cents, total_cents, paid_cents, note, meta, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(docNo, type, status, customerId ?? null, user?.id ?? null, user?.locationId ?? null,
      totals.subtotal, totals.discount, totals.tax, totals.total, paidCents ?? 0, note ?? '', meta ?? '',
      (user?.tenantId) ?? resolveTenantId(this.db));
    const ins = this.db.prepare(`
      INSERT INTO order_lines (order_id, product_id, product_name, qty, unit_price_cents, line_discount_cents, tax_cents, line_total_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const l of lines) {
      ins.run(lastInsertRowid, l.product.id, l.product.name, l.qty, l.unit_cents, l.line_discount, l.tax_cents, l.line_total);
    }
    return { id: lastInsertRowid, docNo };
  }

  _cogs(lines) {
    let total = 0;
    for (const l of lines) {
      if (l.product.is_bundle && l.bundle_components) {
        for (const c of l.bundle_components) {
          const comp = this.catalog.getProduct(c.productId);
          total += c.qty * (comp?.cost_cents || 0);
        }
      } else {
        total += l.qty * (l.product.cost_cents || 0);
      }
    }
    return total;
  }

  // ---------------- Checkout (SALE) ----------------
  checkout({ items, payments, customerId, orderDiscountPercent, note, user }) {
    if (!Array.isArray(items) || items.length === 0) throw badRequest('ITEMS_REQUIRED');
    const lines = items.map(i => this.buildLine(i));
    const totals = this._totals(lines, orderDiscountPercent);
    const { splits, cashInput, credited } = this._validatePayments(payments);
    let change = 0;
    if (cashInput + credited < totals.total) throw badRequest(`UNPAID: need ${totals.total - cashInput - credited} cents more`);

    if (credited > 0) {
      if (!customerId) throw badRequest('CREDIT_SALE_REQUIRES_CUSTOMER');
      const bal = this.invoicing.arOutstanding(customerId);
      const limit = this.db.prepare('SELECT credit_limit_cents FROM customers WHERE id = ?').get(customerId).credit_limit_cents;
      if (limit <= 0) throw conflict('CREDIT_LIMIT_NOT_SET');
      if (bal + credited > limit) throw conflict(`CREDIT_LIMIT_EXCEEDED: outstanding ${bal}, adding ${credited}, limit ${limit}`);
    }

    // availability check
    for (const l of lines) {
      if (l.product.is_bundle && l.bundle_components) {
        for (const c of l.bundle_components) {
          if (this.catalog.available(c.productId) < c.qty) throw conflict(`INSUFFICIENT_STOCK: ${c.productId} (bundle component of ${l.product.name})`);
        }
      } else if (this.catalog.available(l.product.id) < l.qty) {
        throw conflict(`INSUFFICIENT_STOCK: ${l.product.name}`);
      }
    }

    const againstStock = lines;
    const sale = tx(this.db, () => {
      if (cashInput > totals.total) change = cashInput - totals.total;
      const appliedCash = Math.max(0, (splits.CASH || 0) - change);
      const appliedBank = (splits.CARD || 0) + (splits.MOBILE || 0) + (splits.ECOCASH || 0) + (splits.BANK || 0)
        + Math.max(0, change - (splits.CASH || 0));

      const { id, docNo } = this._insertOrder({
        type: 'SALE', status: 'PAID', lines, totals, customerId, user, note,
        paidCents: totals.total,
        meta: JSON.stringify({ payments: splits, change, applied_cash: (splits.CASH || 0) - Math.min(change, splits.CASH || 0) }),
      });

      const cogs = this._cogs(lines);
      const journalLines = [];
      if (appliedCash > 0) journalLines.push({ code: '1000', debit: appliedCash, credit: 0 });
      if (appliedBank > 0) journalLines.push({ code: '1010', debit: appliedBank, credit: 0 });
      if (credited > 0) journalLines.push({ code: '1100', debit: credited, credit: 0 });
      journalLines.push(
        { code: '4100', debit: totals.discount, credit: 0 },
        { code: '4000', debit: 0, credit: totals.subtotal },
        { code: '2100', debit: 0, credit: totals.tax },
        { code: '5100', debit: cogs, credit: 0 },
        { code: '1200', debit: 0, credit: cogs },
      );
      this.acct.postEntry({
        date: new Date().toISOString().slice(0, 10), description: `POS sale ${docNo}`, reference: docNo, lines: journalLines, user,
      });

      this._applyStock(againstStock, -1, 'SALE', 'order', id, user?.id);

      if (credited > 0) {
        this.invoicing.createArInvoice({
          customerId, orderId: id,
          subtotalCents: totals.subtotal, discountCents: totals.discount, taxCents: totals.tax, note: `Credit sale ${docNo}`,
        });
      }
      if (customerId) {
        this.db.prepare('UPDATE customers SET loyalty_points = loyalty_points + ? WHERE id = ?').run(Math.floor(totals.total / 100), customerId);
      }
      this.auth.audit(user?.id, user?.username, 'SALE_CREATE', 'order', id, docNo);
      return this.getOrder(id);
    });
    return { ...sale, change };
  }

  // ---------------- Layaway ----------------
  createLayaway({ items, customerId, deposit, discountPercent, note, user }) {
    if (!customerId) throw badRequest('LAYAWAY_REQUIRES_CUSTOMER');
    if (!Array.isArray(items) || items.length === 0) throw badRequest('ITEMS_REQUIRED');
    const lines = items.map(i => this.buildLine(i));
    const totals = this._totals(lines, discountPercent);
    const dep = Math.round(Number(deposit ?? 0));
    if (dep < 0) throw badRequest('NEGATIVE_DEPOSIT');
    for (const l of lines) {
      if (l.product.is_bundle && l.bundle_components) {
        for (const c of l.bundle_components) {
          if (this.catalog.available(c.productId) < c.qty) throw conflict(`INSUFFICIENT_STOCK: ${c.productId} (bundle component)`);
        }
      } else if (this.catalog.available(l.product.id) < l.qty) {
        throw conflict(`INSUFFICIENT_STOCK: ${l.product.name}`);
      }
    }
    return tx(this.db, () => {
      const { id, docNo } = this._insertOrder({
        type: 'LAYAWAY', status: 'OPEN', lines, totals, customerId, user, note,
        paidCents: dep, meta: JSON.stringify({ deposit: dep, payments: { CASH: dep } }),
      });
      // reserve stock
      for (const l of lines) {
        if (l.product.is_bundle && l.bundle_components) {
          for (const c of l.bundle_components) this.catalog.reserve(c.productId, c.qty, 'order', id);
        } else {
          this.catalog.reserve(l.product.id, l.qty, 'order', id);
        }
      }
      // journal deposit
      this.acct.postEntry({
        date: new Date().toISOString().slice(0, 10), description: `Layaway deposit ${docNo}`,
        reference: docNo, lines: [
          { code: '1000', amount: dep },
          { code: '2200', amount: dep },
        ], user,
      });
      this.auth.audit(user?.id, user?.username, 'LAYAWAY_CREATE', 'order', id, docNo);
      return this.getOrder(id);
    });
  }

  addLayawayPayment(orderId, payments, user) {
    const order = this.getOrder(orderId);
    if (order.type !== 'LAYAWAY' || order.status !== 'OPEN') throw conflict('ORDER_NOT_OPEN_LAYAWAY');
    const { splits, credited } = this._validatePayments(payments);
    if (credited > 0) throw badRequest('LAYAWAY_DEPOSITS_MUST_BE_CASH_LIKE');
    const amount = Object.values(splits).reduce((a, b) => a + b, 0);
    if (order.paid_cents + amount > order.total_cents) throw badRequest('PAYMENT_EXCEEDS_BALANCE');
    return tx(this.db, () => {
      const newPaid = order.paid_cents + amount;
      const prev = JSON.parse(order.meta || '{}');
      this.db.prepare('UPDATE orders SET paid_cents = ?, meta = ? WHERE id = ?')
        .run(newPaid, JSON.stringify({
          ...prev,
          payments: { CASH: (prev.payments?.CASH || prev.deposit || 0) + amount },
        }), orderId);
      this.acct.postEntry({
        date: new Date().toISOString().slice(0, 10), description: `Layaway payment ${order.doc_no}`,
        reference: order.doc_no,
        lines: [
          { code: cashTarget('CASH'), amount },
          { code: '2200', amount },
        ], user,
      });
      return this.getOrder(orderId);
    });
  }

  finalizeLayaway(orderId, payments, user) {
    const order = this.getOrder(orderId);
    if (order.type !== 'LAYAWAY' || order.status !== 'OPEN') throw conflict('ORDER_NOT_OPEN_LAYAWAY');
    const { splits, credited } = this._validatePayments(payments);
    if (credited > 0) throw badRequest('FINAL_PAYMENT_MUST_BE_CASH_LIKE');
    const final = Object.values(splits).reduce((a, b) => a + b, 0);
    const remaining = order.total_cents - order.paid_cents;
    if (final < remaining) throw badRequest(`PARTIAL_FINAL: ${final} < ${remaining}`);
    const change = final - remaining;

    return tx(this.db, () => {
      this.db.prepare("UPDATE orders SET status = 'COMPLETED', paid_cents = total_cents, meta = ? WHERE id = ?")
        .run(JSON.stringify({ ...JSON.parse(order.meta || '{}'), final_amt: final, payments: { CASH: order.paid_cents + final - change } }), orderId);
      const cogs = order.lines.reduce((s, l) => s + l.qty * (this.catalog.getProduct(l.product_id).cost_cents || 0), 0);
      for (const l of order.lines) {
        this.catalog.release(l.product_id, l.qty, 'order', orderId);
        this.catalog.move({ productId: l.product_id, qty: -l.qty, type: 'SALE', refType: 'order', refId: orderId, note: `layaway ${order.doc_no}`, userId: user?.id });
      }
      const deposits = order.paid_cents;
      this.acct.postEntry({
        date: new Date().toISOString().slice(0, 10), description: `Layaway completion ${order.doc_no}`, reference: order.doc_no,
        lines: [
          { code: '2200', debit: deposits, credit: 0 },
          { code: '1000', debit: order.total_cents - deposits, credit: 0 },
          { code: '4100', debit: order.discount_cents, credit: 0 },
          { code: '4000', debit: 0, credit: order.subtotal_cents },
          { code: '2100', debit: 0, credit: order.tax_cents },
          { code: '5100', debit: cogs, credit: 0 },
          { code: '1200', debit: 0, credit: cogs },
        ], user,
      });
      if (order.customer_id) {
        this.db.prepare('UPDATE customers SET loyalty_points = loyalty_points + ? WHERE id = ?').run(Math.floor(order.total_cents / 100), order.customer_id);
      }
      return this.getOrder(orderId);
    });
  }

  cancelLayaway(orderId, user) {
    const order = this.getOrder(orderId);
    if (order.type !== 'LAYAWAY' || order.status !== 'OPEN') throw conflict('ORDER_NOT_OPEN_LAYAWAY');
    return tx(this.db, () => {
      this.db.prepare("UPDATE orders SET status = 'VOID' WHERE id = ?").run(orderId);
      for (const l of order.lines) this.catalog.release(l.product_id, l.qty, 'order', orderId);
      if (order.paid_cents > 0) {
        this.acct.postEntry({
          date: new Date().toISOString().slice(0, 10), description: `Layaway refund ${order.doc_no}`, reference: order.doc_no,
          lines: [
            { code: '2200', debit: order.paid_cents, credit: 0 },
            { code: '1000', debit: 0, credit: order.paid_cents },
          ], user,
        });
      }
      this.auth.audit(user?.id, user?.username, 'LAYAWAY_VOID', 'order', orderId, order.doc_no);
      return this.getOrder(orderId);
    });
  }

  // ---------------- Quote ----------------
  createQuote({ items, customerId, discountPercent, note, user }) {
    if (!Array.isArray(items) || items.length === 0) throw badRequest('ITEMS_REQUIRED');
    const lines = items.map(i => this.buildLine(i));
    const totals = this._totals(lines, discountPercent);
    return tx(this.db, () => {
      const { id, docNo } = this._insertOrder({
        type: 'QUOTE', status: 'OPEN', lines, totals, customerId, user, note,
      });
      this.auth.audit(user?.id, user?.username, 'QUOTE_CREATE', 'order', id, docNo);
      return this.getOrder(id);
    });
  }

  convertQuote(orderId, payments, user) {
    const order = this.getOrder(orderId);
    if (order.type !== 'QUOTE' || order.status !== 'OPEN') throw conflict('ORDER_NOT_OPEN_QUOTE');
    const items = order.lines.map(l => ({
      productId: l.product_id, qty: l.qty,
      unitPriceCents: l.unit_price_cents, lineDiscountCents: l.line_discount_cents,
    }));
    const sale = this.checkout({ items, payments, customerId: order.customer_id, note: `from quote ${order.doc_no}`, user });
    tx(this.db, () => {
      this.db.prepare("UPDATE orders SET status = 'CONVERTED' WHERE id = ?").run(orderId);
    });
    return sale;
  }

  // ---------------- Refund ----------------
  refund({ saleId, items, method = 'CASH', reason, user }) {
    const sale = this.getOrder(saleId);
    if (sale.type !== 'SALE' || sale.status !== 'PAID') throw conflict('NOT_A_PAID_SALE');
    const remainingRefundable = sale.total_cents - sale.refunded_cents;
    if (remainingRefundable <= 0) throw conflict('ALREADY_FULLY_REFUNDED');
    if (!Array.isArray(items) || items.length === 0) throw badRequest('ITEMS_REQUIRED');

    const lines = items.map((it) => {
      const orig = sale.lines.find(l => l.product_id === it.productId);
      if (!orig) throw notFound(`PRODUCT_NOT_ON_SALE: ${it.productId}`);
      const qty = Math.round(Number(it.qty));
      if (qty < 1 || qty > orig.qty) throw badRequest(`INVALID_QTY: ${orig.product_name}`);
      return this.buildLine({ productId: orig.product_id, qty, unitPriceCents: orig.unit_price_cents });
    });
    const totals = this._totals(lines, 0);
    if (totals.total > remainingRefundable) throw badRequest('REFUND_EXCEEDS_REMAINING');
    if (!METHODS.has(method) || method === 'CREDIT') throw badRequest('REFUND_METHOD_MUST_BE_CASH_LIKE');

    const refundNo = nextDoc(this.db, 'RFD');
    return tx(this.db, () => {
      const { id } = this._insertOrder({
        type: 'REFUND', status: 'PAID', lines, totals: { ...totals, subtotal: -totals.subtotal, discount: -totals.discount, tax: -totals.tax, total: -totals.total },
        customerId: sale.customer_id, user, note: reason || '',
        meta: JSON.stringify({ return_cash: totals.total, method }),
      });
      // restore stock
      for (const l of lines) {
        this.catalog.move({ productId: l.product.id, qty: l.qty, type: 'REFUND', refType: 'order', refId: id, note: refundNo, userId: user?.id });
      }
      const cogs = lines.reduce((s, l) => s + l.qty * l.product.cost_cents, 0);
      this.acct.postEntry({
        date: new Date().toISOString().slice(0, 10), description: `Refund ${refundNo} of ${sale.doc_no}`, reference: refundNo,
        lines: [
          { code: '4200', debit: totals.subtotal - totals.discount, credit: 0 },
          { code: '2100', debit: totals.tax, credit: 0 },
          { code: cashTarget(method), debit: 0, credit: totals.total },
          { code: '1200', debit: cogs, credit: 0 },
          { code: '5100', debit: 0, credit: cogs },
        ], user,
      });
      this.db.prepare('UPDATE orders SET refunded_cents = refunded_cents + ? WHERE id = ?').run(totals.total, sale.id);
      this.auth.audit(user?.id, user?.username, 'SALE_REFUND', 'order', id, refundNo);
      return this.getOrder(id);
    });
  }

  orders({ type, status, tenantId, limit = 100 } = {}) {
    const tenant = resolveTenantId(this.db, tenantId);
    const where = ['o.tenant_id = ?']; const vals = [tenant];
    if (type) { where.push('o.type = ?'); vals.push(type); }
    if (status) { where.push('o.status = ?'); vals.push(status); }
    return this.db.prepare(`
      SELECT o.*, c.name AS customer_name FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.id DESC LIMIT ?
    `).all(...vals, limit);
  }
}