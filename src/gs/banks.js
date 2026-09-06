// Bank accounts/reconciliation service ported onto shared bank tables.

import { tx } from './db.js';
import { badRequest } from './errors.js';
import { todayLocal } from './ids.js';

class BanksService {
  constructor(db) {
    this.db = db;
  }

  accounts() {
    return this.db.prepare(`
      SELECT b.*, a.code AS gl_code FROM bank_accounts b JOIN accounts a ON a.id = b.account_id ORDER BY b.id
    `).all();
  }

  defaultAccount() {
    let bank = this.db.prepare('SELECT * FROM bank_accounts WHERE account_id = (SELECT id FROM accounts WHERE code = ?)').get('1010');
    if (!bank) {
      const acc = this.db.prepare("SELECT id FROM accounts WHERE code = '1010'").get();
      if (!acc) throw badRequest('BANK_ACCOUNT_NOT_FOUND');
      this.db.prepare('INSERT INTO bank_accounts (account_id, name, opening_cents) VALUES (?, ?, 0)').run(acc.id, 'Bank – Main');
      bank = this.db.prepare('SELECT * FROM bank_accounts WHERE account_id = ?').get(acc.id);
    }
    return bank;
  }

  transactions({ bankAccountId, reconciled, limit = 300 } = {}) {
    const where = ['1=1']; const vals = [];
    if (bankAccountId) { where.push('bank_account_id = ?'); vals.push(bankAccountId); }
    if (reconciled !== undefined) { where.push('reconciled = ?'); vals.push(reconciled ? 1 : 0); }
    return this.db.prepare(`
      SELECT * FROM bank_transactions WHERE ${where.join(' AND ')}
      ORDER BY date DESC, id DESC LIMIT ?
    `).all(...vals, limit);
  }

  addManual({ bankAccountId, date, memo, amount, user }) {
    const amountCents = Math.round(Number(amount));
    if (!amountCents) throw badRequest('AMOUNT_REQUIRED');
    const bank = bankAccountId ? this.db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(bankAccountId) : this.defaultAccount();
    if (!bank) throw badRequest('BANK_ACCOUNT_NOT_FOUND');
    return this.db.prepare(
      'INSERT INTO bank_transactions (bank_account_id, date, memo, amount_cents) VALUES (?, ?, ?, ?)'
    ).run(bank.id, date ?? todayLocal(), memo ?? 'Manual entry', amountCents).lastInsertRowid;
  }

  reconcile({ bankAccountId, statementDate, closingBalance, transactionIds }) {
    const bank = bankAccountId ? this.db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(bankAccountId) : this.defaultAccount();
    if (!bank) throw badRequest('BANK_ACCOUNT_NOT_FOUND');
    const ids = (transactionIds || []).map(Number);
    if (!ids.length) throw badRequest('SELECT_TRANSACTIONS_TO_RECONCILE');
    return tx(this.db, (db) => {
      const recId = db.prepare(
        'INSERT INTO reconciliations (bank_account_id, statement_date, closing_balance_cents) VALUES (?, ?, ?)'
      ).run(bank.id, statementDate ?? todayLocal(), Math.round(Number(closingBalance ?? 0))).lastInsertRowid;
      const upd = db.prepare('UPDATE bank_transactions SET reconciled = 1, rec_id = ? WHERE id = ? AND bank_account_id = ?');
      for (const id of ids) upd.run(recId, id, bank.id);
      return recId;
    });
  }

  reconciliations() {
    return this.db.prepare('SELECT * FROM reconciliations ORDER BY id DESC').all();
  }
}

export { BanksService };