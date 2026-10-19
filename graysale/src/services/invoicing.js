import { tx, nextDoc } from '../db/database.js';
import { badRequest, notFound } from '../lib/errors.js';
import { localDate, todayLocal } from '../lib/ids.js';
import { resolveTenantId } from '../lib/tenant.js';
import { ACC } from './accounting.js';

const dueFrom = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + (days ?? 14));
  return localDate(d);
};

export class InvoicingService {
  constructor(db, { accounting = null } = {}) {
    this.db = db;
    this.acct = accounting;
    this.termsDays = Number(
      this.db.prepare("SELECT value FROM settings WHERE key = 'doc.default_terms_days'").get()?.value ?? 14,
    );
  }

  // ---- Accounts Receivable ----
  createArInvoice({
    customerId,
    orderId = null,
    subtotalCents = 0,
    discountCents = 0,
    taxCents = 0,
    dueDays,
    note = '',
    tenantId,
  }) {
    const tenant = resolveTenantId(this.db, tenantId);
    const customer = this.db.prepare('SELECT id FROM customers WHERE id = ? AND tenant_id = ?').get(customerId, tenant);
    if (!customer) throw badRequest('CUSTOMER_NOT_FOUND');
    return tx(this.db, () => {
      const docNo = nextDoc(this.db, 'INV');
      const totalCents = subtotalCents - discountCents + taxCents;
      const { lastInsertRowid } = this.db
        .prepare(
          `
        INSERT INTO ar_invoices (doc_no, customer_id, order_id, kind, date, due_date, subtotal_cents, discount_cents, tax_cents, total_cents, note, tenant_id)
        VALUES (?, ?, ?, 'INVOICE', ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          docNo,
          customerId,
          orderId,
          todayLocal(),
          dueFrom(dueDays),
          subtotalCents,
          discountCents,
          taxCents,
          totalCents,
          note,
          tenant,
        );
      // Standalone invoices accrue the AR balance in the GL. Invoices created
      // by a POS credit sale are already journaled by the sale materialization,
      // so only standalone invoices post here.
      if (this.acct && !orderId && totalCents > 0) {
        this.acct.postEntry({
          date: todayLocal(),
          description: `Invoice ${docNo}`,
          reference: docNo,
          lines: [
            { code: ACC.AR, debit: totalCents, credit: 0 },
            { code: ACC.SALES_REVENUE, debit: 0, credit: subtotalCents },
            ...(discountCents > 0 ? [{ code: ACC.SALES_DISCOUNTS, debit: discountCents, credit: 0 }] : []),
            ...(taxCents > 0 ? [{ code: ACC.OUTPUT_TAX, debit: 0, credit: taxCents }] : []),
          ],
        });
      }
      return this.getAr(lastInsertRowid, tenant);
    });
  }

  // Credit note = negative invoice against the customer account.
  createCreditNote({
    customerId,
    orderId = null,
    subtotalCents = 0,
    discountCents = 0,
    taxCents = 0,
    note = '',
    tenantId,
  }) {
    const tenant = resolveTenantId(this.db, tenantId);
    return tx(this.db, () => {
      const docNo = nextDoc(this.db, 'CN');
      const totalCents = -(subtotalCents - discountCents + taxCents);
      const { lastInsertRowid } = this.db
        .prepare(
          `
        INSERT INTO ar_invoices (doc_no, customer_id, order_id, kind, date, subtotal_cents, discount_cents, tax_cents, total_cents, note, status, tenant_id)
        VALUES (?, ?, ?, 'CREDIT_NOTE', ?, ?, ?, ?, ?, ?, 'PAID', ?)
      `,
        )
        .run(
          docNo,
          customerId,
          orderId,
          todayLocal(),
          -subtotalCents,
          -discountCents,
          -taxCents,
          totalCents,
          note,
          tenant,
        );
      // Reverse the original accrual: reduce AR, reverse revenue + output tax.
      if (this.acct && totalCents < 0) {
        const returned = subtotalCents - discountCents;
        this.acct.postEntry({
          date: todayLocal(),
          description: `Credit note ${docNo}`,
          reference: docNo,
          lines: [
            { code: ACC.AR, debit: 0, credit: -totalCents },
            { code: ACC.SALES_RETURNS, debit: returned, credit: 0 },
            ...(taxCents > 0 ? [{ code: ACC.OUTPUT_TAX, debit: taxCents, credit: 0 }] : []),
          ],
        });
      }
      return this.getAr(lastInsertRowid, tenant);
    });
  }

  getAr(id, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const inv = this.db
      .prepare(
        `
      SELECT i.*, c.name AS customer_name FROM ar_invoices i
      JOIN customers c ON c.id = i.customer_id WHERE i.id = ? AND i.tenant_id = ?
    `,
      )
      .get(id, tenant);
    if (!inv) throw notFound('INVOICE_NOT_FOUND');
    return inv;
  }

  listAr({ customerId, status, kind, tenantId, limit = 200 } = {}) {
    const tenant = resolveTenantId(this.db, tenantId);
    const where = ['voided = 0', 'tenant_id = ?'];
    const vals = [tenant];
    if (customerId) {
      where.push('customer_id = ?');
      vals.push(customerId);
    }
    if (status) {
      where.push('status = ?');
      vals.push(status);
    }
    if (kind) {
      where.push('kind = ?');
      vals.push(kind);
    }
    return this.db
      .prepare(
        `
      SELECT i.*, c.name AS customer_name FROM ar_invoices i
      JOIN customers c ON c.id = i.customer_id
      WHERE ${where.join(' AND ')} ORDER BY i.id DESC LIMIT ?
    `,
      )
      .all(...vals, limit);
  }

  arOutstanding(customerId, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    return this.db
      .prepare(
        `SELECT COALESCE(SUM(total_cents - paid_cents), 0) AS o FROM ar_invoices
      WHERE customer_id = ? AND tenant_id = ? AND voided = 0 AND status != 'PAID'`,
      )
      .get(customerId, tenant).o;
  }

  applyPaymentToInvoice(invoiceId, amountCents, tenantId) {
    const inv = this.getAr(invoiceId, tenantId);
    if (inv.voided) throw badRequest('INVOICE_VOIDED');
    const newPaid = (inv.paid_cents || 0) + amountCents;
    if (newPaid > inv.total_cents + 1) throw badRequest('OVERPAYMENT');
    const status = newPaid >= inv.total_cents ? 'PAID' : 'PARTIAL';
    this.db.prepare('UPDATE ar_invoices SET paid_cents = ?, status = ? WHERE id = ?').run(newPaid, status, inv.id);
    return status;
  }

  // ---- Accounts Payable ----
  createApBill({ supplierId, poId = null, subtotalCents = 0, taxCents = 0, dueDays, note = '', tenantId }) {
    const tenant = resolveTenantId(this.db, tenantId);
    return tx(this.db, () => {
      const docNo = nextDoc(this.db, 'BILL');
      const totalCents = subtotalCents + taxCents;
      const { lastInsertRowid } = this.db
        .prepare(
          `
        INSERT INTO ap_bills (doc_no, supplier_id, po_id, date, due_date, subtotal_cents, tax_cents, total_cents, note, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          docNo,
          supplierId,
          poId ?? null,
          todayLocal(),
          dueFrom(dueDays),
          subtotalCents,
          taxCents,
          totalCents,
          note,
          tenant,
        );
      // A bill creates the Accounts Payable liability (and the stock-in value +
      // recoverable input tax). Applies to both PO receipts and standalone bills.
      if (this.acct && totalCents > 0) {
        this.acct.postEntry({
          date: todayLocal(),
          description: `Bill ${docNo}`,
          reference: docNo,
          lines: [
            { code: ACC.AP, debit: 0, credit: totalCents },
            { code: ACC.INVENTORY, debit: subtotalCents, credit: 0 },
            ...(taxCents > 0 ? [{ code: ACC.INPUT_TAX, debit: taxCents, credit: 0 }] : []),
          ],
        });
      }
      return this.getAp(lastInsertRowid, tenant);
    });
  }

  getAp(id, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const bill = this.db
      .prepare(
        `
      SELECT b.*, s.name AS supplier_name FROM ap_bills b JOIN suppliers s ON s.id = b.supplier_id WHERE b.id = ? AND b.tenant_id = ?
    `,
      )
      .get(id, tenant);
    if (!bill) throw notFound('BILL_NOT_FOUND');
    return bill;
  }

  listAp({ supplierId, status, tenantId, limit = 200 } = {}) {
    const tenant = resolveTenantId(this.db, tenantId);
    const where = ['voided = 0', 'tenant_id = ?'];
    const vals = [tenant];
    if (supplierId) {
      where.push('supplier_id = ?');
      vals.push(supplierId);
    }
    if (status) {
      where.push('status = ?');
      vals.push(status);
    }
    return this.db
      .prepare(
        `
      SELECT b.*, s.name AS supplier_name FROM ap_bills b JOIN suppliers s ON s.id = b.supplier_id
      WHERE ${where.join(' AND ')} ORDER BY b.id DESC LIMIT ?
    `,
      )
      .all(...vals, limit);
  }

  applyPaymentToBill(billId, amountCents, tenantId) {
    const bill = this.getAp(billId, tenantId);
    if (bill.voided) throw badRequest('BILL_VOIDED');
    const newPaid = (bill.paid_cents || 0) + amountCents;
    if (newPaid > bill.total_cents + 1) throw badRequest('OVERPAYMENT');
    const status = newPaid >= bill.total_cents ? 'PAID' : 'PARTIAL';
    this.db.prepare('UPDATE ap_bills SET paid_cents = ?, status = ? WHERE id = ?').run(newPaid, status, bill.id);
    return status;
  }
}
