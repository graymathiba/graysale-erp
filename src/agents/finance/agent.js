import { Agent } from '../agent.js';
import { createResult, createAuditEntry, ResultStatus } from '../message.js';

class FinanceAgent extends Agent {
  constructor(store) {
    super({
      name: 'FIN_AGENT',
      role: 'Finance — General Ledger, AP, AR, Tax, Financial Reports',
      capabilities: [
        'ledger.get_balance', 'ledger.post', 'ledger.verify',
        'ar.invoice', 'ap.pay',
        'reports.trial_balance', 'reports.pl', 'reports.balance_sheet',
        'reports.chart', 'reports.tax_summary',
      ],
    });
    this.store = store;
  }

  async handle(message) {
    const { domain, payload } = message;
    const action = domain.split('.').slice(1).join('.');

    switch (action) {
      case 'get_balance': return this.getBalance(payload);
      case 'post': return this.postJournal(payload);
      case 'verify': return this.verifyBalanced();
      case 'trial_balance': return this.trialBalance();
      case 'pl': return this.profitAndLoss();
      case 'balance_sheet': return this.balanceSheet();
      case 'chart': return this.chartOfAccounts();
      case 'invoice': return this.createInvoice(payload);
      case 'pay': return this.processPayment(payload);
      case 'tax_summary': return this.taxSummary(payload);
      default: return createResult({ status: ResultStatus.FAILURE, error: `Unknown finance action: ${action}` });
    }
  }

  getBalance({ accountCode }) {
    const row = this.store.db.prepare('SELECT * FROM accounts WHERE code = ?').get(accountCode);
    return createResult({ data: row || null, audit: [createAuditEntry(this.name, 'get_balance', accountCode)] });
  }

  postJournal({ entryNo, reference, description, lines }) {
    const db = this.store.db;
    db.exec('BEGIN');
    try {
      const entry = db.prepare(
        'INSERT INTO journal_entries (entry_no, reference, description) VALUES (?, ?, ?)'
      ).run(entryNo, reference, description);
      const entryId = entry.lastInsertRowid;

      const ins = db.prepare(
        'INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?, ?, ?, ?)'
      );
      const updBal = db.prepare(
        'UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?'
      );

      for (const l of lines) {
        const acct = db.prepare('SELECT id FROM accounts WHERE code = ?').get(l.accountCode);
        if (!acct) throw new Error(`Account ${l.accountCode} not found`);
        ins.run(entryId, acct.id, l.debits || 0, l.credits || 0);
        const delta = (l.debits || 0) - (l.credits || 0);
        updBal.run(delta, acct.id);
      }

      db.exec('COMMIT');

      const totalDebits = lines.reduce((s, l) => s + (l.debits || 0), 0);
      const totalCredits = lines.reduce((s, l) => s + (l.credits || 0), 0);
      const balanced = totalDebits === totalCredits;

      return createResult({
        data: { entryId, balanced, totalDebits, totalCredits },
        audit: [createAuditEntry(this.name, 'post_journal', `JE-${entryNo} debits=${totalDebits} credits=${totalCredits}`)],
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  verifyBalanced() {
    const row = this.store.db.prepare(
      'SELECT SUM(debits_cents) AS d, SUM(credits_cents) AS c FROM journal_lines'
    ).get();
    const balanced = row.d === row.c;
    return createResult({
      data: { debits: row.d ?? 0, credits: row.c ?? 0, balanced },
      audit: [createAuditEntry(this.name, 'verify', balanced ? 'BALANCED' : 'IMBALANCED')],
    });
  }

  trialBalance() {
    const rows = this.store.db.prepare(
      `SELECT a.code, a.name, a.type, a.balance_cents,
              SUM(jl.debits_cents) AS total_debits, SUM(jl.credits_cents) AS total_credits,
              (SUM(jl.debits_cents) - SUM(jl.credits_cents)) AS net
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
       GROUP BY a.id ORDER BY a.code`
    ).all();
    return createResult({
      data: rows,
      audit: [createAuditEntry(this.name, 'trial_balance', `${rows.length} accounts`)],
    });
  }

  profitAndLoss() {
    const db = this.store.db;
    const rev = db.prepare("SELECT SUM(balance_cents) AS v FROM accounts WHERE type = 'revenue'").get().v ?? 0;
    const exp = db.prepare("SELECT SUM(balance_cents) AS v FROM accounts WHERE type = 'expense'").get().v ?? 0;
    const cogs = db.prepare("SELECT balance_cents FROM accounts WHERE code = '4100'").get()?.balance_cents ?? 0;
    return createResult({
      data: { revenue: rev, expenses: exp, cogs, grossProfit: rev - cogs, netProfit: rev - exp },
      audit: [createAuditEntry(this.name, 'profit_and_loss', '')],
    });
  }

  balanceSheet() {
    const db = this.store.db;
    const assets = db.prepare("SELECT SUM(balance_cents) AS v FROM accounts WHERE type = 'asset'").get().v ?? 0;
    const liab = db.prepare("SELECT SUM(balance_cents) AS v FROM accounts WHERE type = 'liability'").get().v ?? 0;
    const equityAccts = db.prepare("SELECT SUM(balance_cents) AS v FROM accounts WHERE type = 'equity'").get().v ?? 0;
    const rev = db.prepare("SELECT SUM(balance_cents) AS v FROM accounts WHERE type = 'revenue'").get().v ?? 0;
    const exp = db.prepare("SELECT SUM(balance_cents) AS v FROM accounts WHERE type = 'expense'").get().v ?? 0;
    const equity = equityAccts + (rev - exp);
    return createResult({
      data: { assets, liabilities: liab, equity, netIncome: rev - exp, balanced: assets === liab + equity },
      audit: [createAuditEntry(this.name, 'balance_sheet', '')],
    });
  }

  chartOfAccounts() {
    const rows = this.store.db.prepare('SELECT * FROM accounts ORDER BY code').all();
    return createResult({ data: rows, audit: [createAuditEntry(this.name, 'chart', `${rows.length} accounts`)] });
  }

  createInvoice({ type, partyId, partyName, items, dueDate }) {
    const db = this.store.db;
    db.exec('BEGIN');
    try {
      const invoiceNo = type === 'ar'
        ? `INV-${Date.now()}`
        : `BILL-${Date.now()}`;

      let subtotalCents = 0;
      let taxCents = 0;
      for (const item of items) {
        const lineTotal = item.qty * item.unitPriceCents;
        subtotalCents += lineTotal;
        taxCents += Math.round(lineTotal * (item.taxRate || 0));
      }
      const totalCents = subtotalCents + taxCents;

      const inv = db.prepare(
        `INSERT INTO invoices (invoice_no, type, party_id, party_name, subtotal_cents, tax_cents, total_cents, due_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(invoiceNo, type, partyId ?? null, partyName ?? null, subtotalCents, taxCents, totalCents, dueDate ?? null);

      const invoiceId = inv.lastInsertRowid;
      const ins = db.prepare(
        `INSERT INTO invoice_items (invoice_id, product_id, description, qty, unit_price_cents, line_total_cents, tax_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );

      for (const item of items) {
        const lineTotal = item.qty * item.unitPriceCents;
        const lineTax = Math.round(lineTotal * (item.taxRate || 0));
        ins.run(invoiceId, item.productId ?? null, item.description ?? null, item.qty, item.unitPriceCents, lineTotal, lineTax);
      }

      db.exec('COMMIT');

      const financialImpact = Math.min(totalCents / 100000, 1.0);
      const sensitivity = 0.2;
      const confidence = 0.9;
      const risk = {
        value: Math.round((0.5 * financialImpact + 0.3 * sensitivity + 0.2 * (1 - confidence)) * 1000) / 1000,
        requiresApproval: (0.5 * financialImpact + 0.3 * sensitivity + 0.2 * (1 - confidence)) >= 0.75,
      };

      return createResult({
        data: { invoiceId, invoiceNo, type, partyId, partyName, subtotalCents, taxCents, totalCents, status: 'open', dueDate },
        risk,
        audit: [createAuditEntry(this.name, 'create_invoice', `${type} ${invoiceNo} total=${totalCents}`)],
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  processPayment({ invoiceId, amountCents, method }) {
    const db = this.store.db;
    db.exec('BEGIN');
    try {
      const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
      if (!inv) { db.exec('ROLLBACK'); return createResult({ status: ResultStatus.FAILURE, error: 'INVOICE_NOT_FOUND' }); }

      const newPaid = inv.paid_cents + amountCents;
      const newStatus = newPaid >= inv.total_cents ? 'paid' : 'partial';

      db.prepare(
        "UPDATE invoices SET paid_cents = ?, status = ?, paid_at = datetime('now') WHERE id = ?"
      ).run(newPaid, newStatus, invoiceId);

      const entryNo = `JE-PAY-${Date.now()}`;
      const acctCode = inv.type === 'ar' ? '1100' : '2000';
      const cashCode = '1000';

      const acct = db.prepare('SELECT id FROM accounts WHERE code = ?').get(acctCode);
      const cash = db.prepare('SELECT id FROM accounts WHERE code = ?').get(cashCode);
      if (acct && cash) {
        const entry = db.prepare(
          'INSERT INTO journal_entries (entry_no, reference, description) VALUES (?, ?, ?)'
        ).run(entryNo, inv.invoice_no, `Payment for ${inv.invoice_no}`);
        const entryId = entry.lastInsertRowid;

        if (inv.type === 'ar') {
          db.prepare('INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?, ?, ?, ?)').run(entryId, cash.id, amountCents, 0);
          db.prepare('INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?, ?, ?, ?)').run(entryId, acct.id, 0, amountCents);
          db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(amountCents, cash.id);
          db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(amountCents, acct.id);
        } else {
          db.prepare('INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?, ?, ?, ?)').run(entryId, acct.id, amountCents, 0);
          db.prepare('INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?, ?, ?, ?)').run(entryId, cash.id, 0, amountCents);
          db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(amountCents, cash.id);
          db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(amountCents, acct.id);
        }
      }

      db.exec('COMMIT');

      return createResult({
        data: { invoiceId, amountCents, method, newPaidCents: newPaid, status: newStatus, entryNo },
        audit: [createAuditEntry(this.name, 'process_payment', `invoice=${invoiceId} amount=${amountCents} status=${newStatus}`)],
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  taxSummary({ startDate, endDate }) {
    const db = this.store.db;
    let rows;
    if (startDate && endDate) {
      rows = db.prepare(
        `SELECT type, SUM(tax_cents) AS total_tax_cents, COUNT(*) AS invoice_count
         FROM invoices WHERE created_at >= ? AND created_at <= ? GROUP BY type`
      ).all(startDate, endDate);
    } else {
      rows = db.prepare(
        `SELECT type, SUM(tax_cents) AS total_tax_cents, COUNT(*) AS invoice_count
         FROM invoices GROUP BY type`
      ).all();
    }

    const summary = { ar: { taxCents: 0, count: 0 }, ap: { taxCents: 0, count: 0 }, total: 0 };
    for (const r of rows) {
      const key = r.type === 'ar' ? 'ar' : 'ap';
      summary[key] = { taxCents: r.total_tax_cents ?? 0, count: r.invoice_count ?? 0 };
      summary.total += r.total_tax_cents ?? 0;
    }

    return createResult({
      data: summary,
      audit: [createAuditEntry(this.name, 'tax_summary', `total_tax=${summary.total}`)],
    });
  }
}

export { FinanceAgent };
