import { badRequest, notFound } from '../lib/errors.js';
import { tx, nextDoc } from '../db/database.js';
import { resolveTenantId } from '../lib/tenant.js';

const AR_OUTSTANDING = `COALESCE((SELECT SUM(
    CASE WHEN kind = 'CREDIT_NOTE' THEN total_cents ELSE (total_cents - paid_cents) END
  ) FROM ar_invoices WHERE customer_id = c.id AND voided = 0 AND (kind != 'CREDIT_NOTE' OR status = 'PAID')), 0)`;

export class CustomersService {
  constructor(db) {
    this.db = db;
  }

  list({ search, includeInactive = false, tenantId } = {}) {
    const tenant = resolveTenantId(this.db, tenantId);
    const where = ['c.tenant_id = ?'];
    const vals = [tenant];
    if (!includeInactive) {
      where.push('c.active = 1');
    }
    if (search) {
      where.push('(c.name LIKE ? OR c.code LIKE ? OR c.phone LIKE ?)');
      const q = `%${search}%`;
      vals.push(q, q, q);
    }
    const rows = this.db
      .prepare(
        `
      SELECT c.*, ${AR_OUTSTANDING} AS outstanding_cents,
        COALESCE((SELECT loyalty_points FROM customers WHERE id = c.id), 0) AS points
      FROM customers c
      WHERE ${where.join(' AND ')}
      ORDER BY c.name
    `,
      )
      .all(...vals);
    return rows;
  }

  getAll() {
    return this.list();
  }

  get(id, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const c = this.db
      .prepare(
        `
      SELECT c.*, ${AR_OUTSTANDING} AS outstanding_cents
      FROM customers c WHERE c.id = ? AND c.tenant_id = ?
    `,
      )
      .get(id, tenant);
    if (!c) throw notFound('CUSTOMER_NOT_FOUND');
    return c;
  }

  create(body, tenantId) {
    if (!body.name) throw badRequest('CUSTOMER_NAME_REQUIRED');
    const tenant = resolveTenantId(this.db, tenantId);
    const code = body.code || `C${String(Date.now() % 100000).padStart(5, '0')}`;
    return tx(this.db, () => {
      const id = this.db
        .prepare(
          'INSERT INTO customers (code, name, phone, email, address, tax_id, credit_limit_cents, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          code,
          body.name,
          body.phone ?? null,
          body.email ?? null,
          body.address ?? null,
          body.taxId ?? null,
          Math.round(Number(body.creditLimitCents ?? body.creditLimit ?? 0)),
          tenant,
        ).lastInsertRowid;
      return id;
    });
  }

  update(id, body, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const sets = [];
    const vals = [];
    const map = {
      name: 'name',
      phone: 'phone',
      email: 'email',
      address: 'address',
      taxId: 'tax_id',
      creditLimitCents: 'credit_limit_cents',
      active: 'active',
    };
    for (const [k, col] of Object.entries(map))
      if (body[k] !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(body[k]);
      }
    if (!sets.length) return this.get(id, tenant);
    vals.push(Number(id), tenant);
    this.db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...vals);
    return this.get(id, tenant);
  }

  delete(id, tenantId) {
    this.get(id, tenantId); // throws 404 if missing or out of scope
    this.db.prepare('UPDATE customers SET active = 0 WHERE id = ?').run(Number(id));
    return { ok: true };
  }

  ledger(id, limit = 100, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const invoices = this.db
      .prepare(
        `SELECT doc_no AS ref, date, kind, total_cents as amount, paid_cents, (total_cents - paid_cents) AS balance, status
       FROM ar_invoices WHERE customer_id = ? AND tenant_id = ? AND voided = 0 ORDER BY id DESC LIMIT ?`,
      )
      .all(id, tenant, limit);
    const payments = this.db
      .prepare(
        `SELECT p.doc_no AS ref, p.date, p.method, p.amount_cents,
              COALESCE((SELECT SUM(amount_cents) FROM payment_allocations WHERE payment_id = p.id AND invoice_type = 'AR'), 0) AS applied
       FROM payments p WHERE p.kind = 'RECEIPT' AND p.party_type = 'CUSTOMER' AND p.party_id = ? AND p.tenant_id = ? AND p.voided = 0
       ORDER BY p.id DESC LIMIT ?`,
      )
      .all(id, tenant, limit);
    const outstanding = this.db
      .prepare(
        `SELECT COALESCE(SUM(
          CASE WHEN kind = 'CREDIT_NOTE' THEN total_cents ELSE (total_cents - paid_cents) END
       ), 0) AS o
       FROM ar_invoices WHERE customer_id = ? AND tenant_id = ? AND voided = 0 AND (kind != 'CREDIT_NOTE' OR status = 'PAID')`,
      )
      .get(id, tenant).o;
    return { customer: this.get(id, tenant), invoices, payments, outstanding };
  }

  addPoints(id, points) {
    this.db.prepare(`UPDATE customers SET loyalty_points = loyalty_points + ? WHERE id = ?`).run(points, id);
  }

  // All layaway orders for a customer with their outstanding balances and
  // accumulated payment history (deposits + partial payments from order meta).
  layaways(id, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const layaways = this.db
      .prepare(
        `
      SELECT o.id, o.doc_no, o.status, o.created_at, o.subtotal_cents, o.discount_cents,
             o.tax_cents, o.total_cents, o.paid_cents, o.meta,
             (o.total_cents - o.paid_cents) AS balance_cents
      FROM orders o WHERE o.type = 'LAYAWAY' AND o.customer_id = ? AND o.tenant_id = ?
      ORDER BY o.id DESC
    `,
      )
      .all(id, tenant);
    return layaways.map((o) => {
      let lines = [];
      try {
        lines = this.db.prepare('SELECT * FROM order_lines WHERE order_id = ?').all(o.id);
      } catch (_) {}
      return { ...o, lines, payments: [] };
    });
  }
}

export class SuppliersService {
  constructor(db) {
    this.db = db;
  }

  list({ search, includeInactive = false, tenantId } = {}) {
    const tenant = resolveTenantId(this.db, tenantId);
    const where = ['s.tenant_id = ?'];
    const vals = [tenant];
    if (!includeInactive) {
      where.push('s.active = 1');
    }
    if (search) {
      where.push('(s.name LIKE ? OR s.code LIKE ? OR s.phone LIKE ?)');
      const q = `%${search}%`;
      vals.push(q, q, q);
    }
    return this.db
      .prepare(
        `
      SELECT s.*, COALESCE((SELECT SUM(total_cents - paid_cents) FROM ap_bills WHERE supplier_id = s.id AND tenant_id = ? AND voided = 0 AND status != 'PAID'), 0) AS owing_cents
      FROM suppliers s
      WHERE ${where.join(' AND ')}
      ORDER BY s.name
    `,
      )
      .all(...vals, tenant);
  }

  get(id, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const s = this.db.prepare('SELECT * FROM suppliers WHERE id = ? AND tenant_id = ?').get(id, tenant);
    if (!s) throw notFound('SUPPLIER_NOT_FOUND');
    return s;
  }

  create(body, tenantId) {
    if (!body.name) throw badRequest('SUPPLIER_NAME_REQUIRED');
    const tenant = resolveTenantId(this.db, tenantId);
    const code = body.code || `S${String(Date.now() % 100000).padStart(5, '0')}`;
    return this.db
      .prepare(
        'INSERT INTO suppliers (code, name, phone, email, address, tax_id, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(code, body.name, body.phone ?? null, body.email ?? null, body.address ?? null, body.taxId ?? null, tenant)
      .lastInsertRowid;
  }

  update(id, body, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const sets = [];
    const vals = [];
    const map = { name: 'name', phone: 'phone', email: 'email', address: 'address', taxId: 'tax_id', active: 'active' };
    for (const [k, col] of Object.entries(map))
      if (body[k] !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(body[k]);
      }
    if (!sets.length) return this.get(id, tenant);
    vals.push(Number(id), tenant);
    this.db.prepare(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...vals);
    return this.get(id, tenant);
  }

  delete(id, tenantId) {
    this.get(id, tenantId);
    this.db.prepare('UPDATE suppliers SET active = 0 WHERE id = ?').run(Number(id));
    return { ok: true };
  }

  ledger(id, tenantId) {
    this.get(id, tenantId);
    const tenant = resolveTenantId(this.db, tenantId);
    const bills = this.db
      .prepare(
        `SELECT doc_no AS ref, date, total_cents AS amount, paid_cents, (total_cents - paid_cents) AS balance, status
       FROM ap_bills WHERE supplier_id = ? AND tenant_id = ? AND voided = 0 ORDER BY id DESC`,
      )
      .all(id, tenant);
    const payments = this.db
      .prepare(
        `SELECT p.doc_no AS ref, p.date, p.method, p.amount_cents FROM payments p
       WHERE p.kind = 'EXPENSE' AND p.party_type = 'SUPPLIER' AND p.party_id = ? AND p.tenant_id = ? AND p.voided = 0 ORDER BY p.id DESC`,
      )
      .all(id, tenant);
    const owing = bills.reduce((a, b) => a + (b.balance || 0), 0);
    return { supplier: this.get(id, tenant), bills, payments, owing };
  }
}

export { nextDoc };
