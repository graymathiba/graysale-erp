// Payments service ported onto shared payments/payment_allocations +
// bank_accounts/bank_transactions. Uses cashTarget: CASH -> 1000, else 1010.

import { tx, nextDoc } from './db.js';
import { badRequest, notFound } from './errors.js';
import { todayLocal } from './ids.js';

const cashTarget = (method) => (method === 'CASH' ? '1000' : '1010');

class PaymentsService {
  constructor({ db, accounting, invoicing }) {
    this.db = db;
    this.acct = accounting;
    this.invoicing = invoicing;
  }

  ensureBankAccount() {
    let bank = this.db.prepare('SELECT * FROM bank_accounts WHERE account_id = (SELECT id FROM accounts WHERE code = ?)').get('1010');
    if (!bank) {
      const acc = this.db.prepare("SELECT id FROM accounts WHERE code = '1010'").get();
      if (!acc) throw badRequest('BANK_ACCOUNT_NOT_FOUND'); // 1010 is always seeded by v4
      this.db.prepare("INSERT INTO bank_accounts (account_id, name, opening_cents) VALUES (?, ?, 0)").run(acc.id, 'Bank – Main');
      bank = this.db.prepare('SELECT * FROM bank_accounts WHERE account_id = ?').get(acc.id);
    }
    return bank;
  }

  receivePayment({ customerId, method, amount, allocations = [], reference, date, note, user }) {
    if (!['CASH', 'CARD', 'MOBILE', 'BANK'].includes(method)) throw badRequest('METHOD_MUST_BE_CASH_LIKE');
    const amountCents = Math.round(Number(amount));
    if (amountCents <= 0) throw badRequest('AMOUNT_REQUIRED');
    const allocs = allocations.map(a => ({ ...a, amountCents: Math.round(Number(a.amountCents)) }));
    const allocSum = allocs.reduce((s, a) => s + a.amountCents, 0);
    if (allocs.length > 0 && allocSum !== amountCents) throw badRequest('ALLOCATIONS_MUST_SUM_TO_AMOUNT');
    const cust = this.db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId);
    if (!cust) throw notFound('CUSTOMER_NOT_FOUND');

    return tx(this.db, (db) => {
      const docNo = nextDoc(db, 'PYMT');
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO payments (doc_no, kind, party_type, party_id, method, amount_cents, reference, date, user_id, note)
        VALUES (?, 'RECEIPT', 'CUSTOMER', ?, ?, ?, ?, ?, ?, ?)
      `).run(docNo, customerId, method, amountCents, reference ?? null, date ?? todayLocal(), user?.id ?? null, note ?? '');

      const insAlloc = db.prepare(
        'INSERT INTO payment_allocations (payment_id, invoice_type, invoice_id, amount_cents) VALUES (?, ?, ?, ?)'
      );
      if (allocs.length) {
        for (const a of allocs) {
          insAlloc.run(lastInsertRowid, 'AR', a.invoiceId, a.amountCents);
          this.invoicing.applyPaymentToInvoice(a.invoiceId, a.amountCents);
        }
      } else {
        const open = db.prepare(
          `SELECT id, total_cents - paid_cents AS bal FROM ar_invoices
           WHERE customer_id = ? AND voided = 0 AND status != 'PAID' AND total_cents > 0
           ORDER BY id ASC`
        ).all(customerId);
        let remaining = amountCents;
        for (const inv of open) {
          if (remaining <= 0) break;
          const take = Math.min(inv.bal, remaining);
          insAlloc.run(lastInsertRowid, 'AR', inv.id, take);
          this.invoicing.applyPaymentToInvoice(inv.id, take);
          remaining -= take;
        }
        if (remaining > 0) throw badRequest(`UNALLOCATED: ${remaining} cents over open invoices`);
      }

      this.acct.postEntry({
        date: date ?? todayLocal(), description: `Customer receipt ${docNo}`, reference: docNo,
        lines: [
          { code: cashTarget(method), debit: amountCents, credit: 0 },
          { code: '1100', debit: 0, credit: amountCents },
        ], user,
      });
      if (method === 'BANK') {
        const bank = this.ensureBankAccount();
        db.prepare(
          'INSERT INTO bank_transactions (bank_account_id, date, memo, amount_cents, payment_id) VALUES (?, ?, ?, ?, ?)'
        ).run(bank.id, date ?? todayLocal(), `Receipt ${docNo}`, amountCents, lastInsertRowid);
      }
      return this.getPayment(lastInsertRowid);
    });
  }

  paySupplier({ supplierId, method, amount, allocations = [], reference, date, note, user }) {
    if (!['CASH', 'CARD', 'MOBILE', 'BANK'].includes(method)) throw badRequest('METHOD_MUST_BE_CASH_LIKE');
    const amountCents = Math.round(Number(amount));
    if (amountCents <= 0) throw badRequest('AMOUNT_REQUIRED');
    const allocs = allocations.map(a => ({ ...a, amountCents: Math.round(Number(a.amountCents)) }));
    if (allocs.length && allocs.reduce((s, a) => s + a.amountCents, 0) !== amountCents) throw badRequest('ALLOCATIONS_MUST_SUM_TO_AMOUNT');
    const supp = this.db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId);
    if (!supp) throw notFound('SUPPLIER_NOT_FOUND');

    return tx(this.db, (db) => {
      const docNo = nextDoc(db, 'PYMT');
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO payments (doc_no, kind, party_type, party_id, method, amount_cents, reference, date, user_id, note)
        VALUES (?, 'EXPENSE', 'SUPPLIER', ?, ?, ?, ?, ?, ?, ?)
      `).run(docNo, supplierId, method, amountCents, reference ?? null, date ?? todayLocal(), user?.id ?? null, note ?? '');

      const insAlloc = db.prepare(
        'INSERT INTO payment_allocations (payment_id, invoice_type, invoice_id, amount_cents) VALUES (?, ?, ?, ?)'
      );
      const targets = allocs.length ? allocs : db.prepare(
        `SELECT id AS billId, (total_cents - paid_cents) AS amountCents FROM ap_bills
         WHERE supplier_id = ? AND voided = 0 AND status != 'PAID' AND total_cents > 0 ORDER BY id ASC LIMIT 20`
      ).all(supplierId);
      let remaining = targets.length ? amountCents : 0;
      for (const a of targets) {
        if (remaining <= 0) break;
        const take = Math.min(a.amountCents, remaining);
        insAlloc.run(lastInsertRowid, 'AP', a.billId, take);
        this.invoicing.applyPaymentToBill(a.billId, take);
        remaining -= take;
      }
      if (remaining > 0) throw badRequest(`UNALLOCATED: ${remaining} cents over open bills`);

      this.acct.postEntry({
        date: date ?? todayLocal(), description: `Supplier payment ${docNo}`, reference: docNo,
        lines: [
          { code: '2010', debit: amountCents, credit: 0 },
          { code: cashTarget(method), debit: 0, credit: amountCents },
        ], user,
      });
      if (method === 'BANK') {
        const bank = this.ensureBankAccount();
        db.prepare(
          'INSERT INTO bank_transactions (bank_account_id, date, memo, amount_cents, payment_id) VALUES (?, ?, ?, ?, ?)'
        ).run(bank.id, date ?? todayLocal(), `Payment ${docNo}`, -amountCents, lastInsertRowid);
      }
      return this.getPayment(lastInsertRowid);
    });
  }

  getPayment(id) {
    const p = this.db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
    if (!p) throw notFound('PAYMENT_NOT_FOUND');
    p.allocations = this.db.prepare('SELECT * FROM payment_allocations WHERE payment_id = ?').all(id);
    return p;
  }

  listPayments({ kind, partyType, partyId, limit = 100 } = {}) {
    const where = ['1=1']; const vals = [];
    if (kind) { where.push('kind = ?'); vals.push(kind); }
    if (partyType) { where.push('party_type = ?'); vals.push(partyType); }
    if (partyId) { where.push('party_id = ?'); vals.push(partyId); }
    return this.db.prepare(`SELECT * FROM payments WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...vals, limit);
  }
}

export { PaymentsService, cashTarget };