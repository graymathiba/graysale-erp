// Customers + Suppliers services, ported from graysale onto shared tables
// (customers/suppliers, ar_invoices/ap_bills, payments, payment_allocations).

import { badRequest, notFound } from './errors.js';
import { tx, nextDoc } from './db.js';

// Mirrors the graysale AR/AP formulas exactly (credit notes reduce the balance).
const AR_OUTSTANDING = `
  COALESCE((
    SELECT SUM(CASE WHEN kind = 'CREDIT_NOTE' THEN total_cents ELSE (total_cents - paid_cents) END)
    FROM ar_invoices WHERE customer_id = c.id AND voided = 0 AND (kind != 'CREDIT_NOTE' OR status = 'PAID')
  ), 0) AS outstanding_cents`;

const AP_OWING = `
  COALESCE((
    SELECT SUM(total_cents - paid_cents) FROM ap_bills
    WHERE supplier_id = s.id AND voided = 0 AND status != 'PAID'
  ), 0) AS owing_cents`;

class CustomersService {
  constructor(db) {
    this.db = db;
  }

  list({ search = '', withBalance = true } = {}) {
    const params = [];
    let where = '';
    if (search) {
      where = 'WHERE LOWER(c.name) LIKE ? OR LOWER(c.phone) LIKE ?';
      params.push(`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`);
    }
    return this.db.prepare(
      `SELECT c.*${withBalance ? ',' + AR_OUTSTANDING : ''}
       FROM customers c
       ${where}
       ORDER BY c.name COLLATE NOCASE ASC`
    ).all(...params);
  }

  get(id) {
    const c = this.db.prepare(
      `SELECT c.*, ${AR_OUTSTANDING} FROM customers c WHERE c.id = ?`
    ).get(id);
    if (!c) throw notFound('Customer not found');
    return c;
  }

  findByCode(code) {
    return this.db.prepare('SELECT * FROM customers WHERE code = ?').get(code);
  }

  create(body = {}) {
    const name = String(body.name ?? '').trim();
    if (!name) throw badRequest('Customer name is required');

    return tx(this.db, (db) => {
      let code = String(body.code ?? '').trim();
      if (!code) {
        const row = db.prepare("SELECT MAX(CAST(SUBSTR(code, 3) AS INTEGER)) AS m FROM customers WHERE code LIKE 'C-%'").get();
        code = `C-${(row?.m ?? 0) + 1}`;
      }
      const existing = db.prepare('SELECT id FROM customers WHERE code = ?').get(code);
      if (existing) throw badRequest(`Customer code already exists: ${code}`);
      const creditLimitCents = Math.round(Number(body.creditLimitCents ?? body.credit_limit_cents ?? 0));

      const res = db.prepare(
        `INSERT INTO customers (code, name, phone, email, address, credit_limit_cents, active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(code, name,
            String(body.phone ?? '').trim() || null,
            String(body.email ?? '').trim() || null,
            String(body.address ?? '').trim() || null,
            creditLimitCents,
            body.active === false ? 0 : 1);
      return this.get(res.lastInsertRowid);
    });
  }

  update(id, body = {}) {
    return tx(this.db, (db) => {
      const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
      if (!c) throw notFound('Customer not found');

      const fields = [];
      const params = [];
      if (body.name !== undefined) fields.push('name = ?'), params.push(String(body.name).trim() || c.name);
      if (body.phone !== undefined) fields.push('phone = ?'), params.push(String(body.phone).trim() || null);
      if (body.email !== undefined) fields.push('email = ?'), params.push(String(body.email).trim() || null);
      if (body.address !== undefined) fields.push('address = ?'), params.push(String(body.address).trim() || null);
      if (body.active !== undefined) fields.push('active = ?'), params.push(body.active ? 1 : 0);
      if (body.creditLimitCents !== undefined) fields.push('credit_limit_cents = ?'), params.push(Math.round(Number(body.creditLimitCents)));
      if (body.credit_limit_cents !== undefined) fields.push('credit_limit_cents = ?'), params.push(Math.round(Number(body.credit_limit_cents)));
      if (body.loyalty_points !== undefined) fields.push('loyalty_points = ?'), params.push(Math.round(Number(body.loyalty_points) || 0));
      if (body.total_spent_cents !== undefined) fields.push('total_spent_cents = ?'), params.push(Math.round(Number(body.total_spent_cents) || 0));

      if (fields.length) {
        db.prepare(`UPDATE customers SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
      }
      return this.get(id);
    });
  }

  addPoints(id, points) {
    const c = this.db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!c) throw notFound('Customer not found');
    const pts = Math.round(Number(points) || 0);
    this.db.prepare('UPDATE customers SET loyalty_points = COALESCE(loyalty_points, 0) + ? WHERE id = ?').run(pts, id);
    return this.get(id);
  }

  ledger(id) {
    const customer = this.get(id);
    const outstanding = this.db.prepare(`
      SELECT COALESCE(SUM(
        CASE WHEN kind = 'CREDIT_NOTE' THEN total_cents ELSE (total_cents - paid_cents) END
      ), 0) AS o FROM ar_invoices
      WHERE customer_id = ? AND voided = 0 AND (kind != 'CREDIT_NOTE' OR status = 'PAID')
    `).get(id).o;
    const invoices = this.db.prepare(
      `SELECT doc_no AS ref, date, kind, total_cents AS amount, paid_cents,
              (total_cents - paid_cents) AS balance, status
       FROM ar_invoices WHERE customer_id = ? AND voided = 0 ORDER BY id DESC`
    ).all(id);
    const payments = this.db.prepare(
      `SELECT p.doc_no AS ref, p.date, p.method, p.amount_cents,
              COALESCE((SELECT SUM(amount_cents) FROM payment_allocations WHERE payment_id = p.id AND invoice_type = 'AR'), 0) AS applied
       FROM payments p
       WHERE p.kind = 'RECEIPT' AND p.party_type = 'CUSTOMER' AND p.party_id = ? AND p.voided = 0
       ORDER BY p.id DESC`
    ).all(id);
    return { customer, outstanding, invoices, payments };
  }
}

class SuppliersService {
  constructor(db) {
    this.db = db;
  }

  list({ search = '', withBalance = true } = {}) {
    const params = [];
    let where = '';
    if (search) {
      where = 'WHERE LOWER(s.name) LIKE ? OR LOWER(s.phone) LIKE ?';
      params.push(`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`);
    }
    return this.db.prepare(
      `SELECT s.*${withBalance ? ',' + AP_OWING : ''}
       FROM suppliers s
       ${where}
       ORDER BY s.name COLLATE NOCASE ASC`
    ).all(...params);
  }

  get(id) {
    const s = this.db.prepare(
      `SELECT s.*, ${AP_OWING} FROM suppliers s WHERE s.id = ?`
    ).get(id);
    if (!s) throw notFound('Supplier not found');
    return s;
  }

  create(body = {}) {
    const name = String(body.name ?? '').trim();
    if (!name) throw badRequest('Supplier name is required');
    return tx(this.db, (db) => {
      let code = String(body.code ?? '').trim();
      if (!code) {
        const row = db.prepare("SELECT MAX(CAST(SUBSTR(code, 3) AS INTEGER)) AS m FROM suppliers WHERE code LIKE 'S-%'").get();
        code = `S-${(row?.m ?? 0) + 1}`;
      }
      const res = db.prepare(
        `INSERT INTO suppliers (code, name, phone, email, address, tax_id, active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(code, name,
            String(body.phone ?? '').trim() || null,
            String(body.email ?? '').trim() || null,
            String(body.address ?? '').trim() || null,
            String(body.taxId ?? body.tax_id ?? '').trim() || null,
            body.active === false ? 0 : 1);
      return this.get(res.lastInsertRowid);
    });
  }

  update(id, body = {}) {
    return tx(this.db, (db) => {
      const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
      if (!s) throw notFound('Supplier not found');
      const fields = [];
      const params = [];
      if (body.name !== undefined) fields.push('name = ?'), params.push(String(body.name).trim() || s.name);
      if (body.phone !== undefined) fields.push('phone = ?'), params.push(String(body.phone).trim() || null);
      if (body.email !== undefined) fields.push('email = ?'), params.push(String(body.email).trim() || null);
      if (body.address !== undefined) fields.push('address = ?'), params.push(String(body.address).trim() || null);
      if (body.taxId !== undefined) fields.push('tax_id = ?'), params.push(String(body.taxId).trim() || null);
      if (body.active !== undefined) fields.push('active = ?'), params.push(body.active ? 1 : 0);
      if (fields.length) {
        db.prepare(`UPDATE suppliers SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
      }
      return this.get(id);
    });
  }

  ledger(id) {
    const supplier = this.get(id);
    const bills = this.db.prepare(
      `SELECT doc_no AS ref, date, kind, total_cents AS amount, paid_cents,
              (total_cents - paid_cents) AS balance, status
       FROM ap_bills WHERE supplier_id = ? AND voided = 0 ORDER BY id DESC`
    ).all(id);
    const payments = this.db.prepare(
      `SELECT p.doc_no AS ref, p.date, p.method, p.amount_cents FROM payments p
       WHERE p.kind = 'EXPENSE' AND p.party_type = 'SUPPLIER' AND p.party_id = ? AND p.voided = 0 ORDER BY p.id DESC`
    ).all(id);
    const owing = bills.reduce((a, b) => a + (b.balance || 0), 0);
    return { supplier, bills, payments, owing };
  }
}

export { CustomersService, SuppliersService };