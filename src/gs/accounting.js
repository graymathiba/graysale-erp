// graysale accounting service ported onto the shared journal tables.
// Journal entries written by the main ERP (entry_no like JE-00001) and by the
// retail port (entry_no from the JE counter) coexist in the same tables.

import { tx, nextDoc } from './db.js';
import { badRequest } from './errors.js';

const DEBIT_SIDED = new Set(['asset', 'expense']);

class AccountingService {
  constructor(db) {
    this.db = db;
  }

  chart() {
    return this.db.prepare('SELECT * FROM accounts ORDER BY code').all();
  }

  accountByCode(code) {
    const a = this.db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
    if (!a) throw badRequest(`ACCOUNT_NOT_FOUND: ${code}`);
    return a;
  }

  static lineFor(accountType, amountCents) {
    return DEBIT_SIDED.has(accountType)
      ? { debits_cents: amountCents, credits_cents: 0 }
      : { debits_cents: 0, credits_cents: amountCents };
  }

  // Post a balanced journal entry. lines: [{ code, debit?, credit?, amount? }]
  postEntry({ date, description, reference, lines, user }) {
    const valid = lines.filter(l => l);
    let d = 0, c = 0;
    const resolved = valid.map((l) => {
      const acct = this.accountByCode(l.code);
      let debit = l.debit ?? 0;
      let credit = l.credit ?? 0;
      if (l.amount != null) {
        const side = DEBIT_SIDED.has(acct.type);
        debit = side ? l.amount : 0;
        credit = side ? 0 : l.amount;
      }
      d += debit; c += credit;
      return { account_id: acct.id, debits_cents: debit, credits_cents: credit };
    });
    if (d !== c) throw badRequest('UNBALANCED_ENTRY');
    if (d === 0) throw badRequest('EMPTY_ENTRY');

    return tx(this.db, (db) => {
      const docNo = nextDoc(db, 'JE');
      const { lastInsertRowid } = db.prepare(
        'INSERT INTO journal_entries (entry_no, date, description, reference, user_id) VALUES (?, ?, ?, ?, ?)'
      ).run(docNo, date ?? new Date().toISOString().slice(0, 10), description ?? '', reference ?? '', user?.id ?? null);
      const ins = db.prepare(
        'INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?, ?, ?, ?)'
      );
      for (const l of resolved) ins.run(lastInsertRowid, l.account_id, l.debits_cents, l.credits_cents);
      return this.entry(lastInsertRowid);
    });
  }

  entry(id) {
    return this.db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(id);
  }

  entries({ limit = 200, accountCode } = {}) {
    if (accountCode) {
      const acct = this.accountByCode(accountCode);
      return this.db.prepare(`
        SELECT jl.*, j.entry_no AS doc_no, j.date, j.reference, j.description, a.code AS account_code, a.name AS account_name
        FROM journal_lines jl
        JOIN journal_entries j ON j.id = jl.entry_id
        JOIN accounts a ON a.id = jl.account_id
        WHERE a.id = ? ORDER BY j.id DESC LIMIT ?
      `).all(acct.id, limit);
    }
    return this.db.prepare(`
      SELECT j.*, j.entry_no AS doc_no,
             (SELECT SUM(debits_cents) FROM journal_lines WHERE entry_id = j.id) AS debits,
             (SELECT SUM(credits_cents) FROM journal_lines WHERE entry_id = j.id) AS credits
      FROM journal_entries j ORDER BY j.id DESC LIMIT ?
    `).all(limit);
  }

  entryLines(entryId) {
    return this.db.prepare(`
      SELECT jl.*, a.code, a.name, a.type
      FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
      WHERE jl.entry_id = ? ORDER BY jl.id
    `).all(entryId);
  }

  balances() {
    const rows = this.db.prepare(`
      SELECT a.id, a.code, a.name, a.type,
        COALESCE(SUM(jl.debits_cents), 0) AS debits,
        COALESCE(SUM(jl.credits_cents), 0) AS credits
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_id = a.id
      GROUP BY a.id ORDER BY a.code
    `).all();
    return rows.map(r => ({
      ...r,
      debitBalance: r.debits - r.credits,
      creditBalance: r.credits - r.debits,
      balance: (DEBIT_SIDED.has(r.type) ? r.debits - r.credits : r.credits - r.debits),
    }));
  }

  trialBalance() {
    return this.balances().map(b => {
      const isDebitNormal = DEBIT_SIDED.has(b.type);
      let debits = 0, credits = 0;
      if (b.balance > 0) {
        if (isDebitNormal) debits = b.balance; else credits = b.balance;
      } else if (b.balance < 0) {
        if (isDebitNormal) credits = -b.balance; else debits = -b.balance;
      }
      return { code: b.code, name: b.name, type: b.type, debits, credits };
    });
  }

  profitAndLoss() {
    const b = this.balances();
    const rev = b.filter(a => a.type === 'revenue').reduce((s, a) => s + a.balance, 0);
    const exp = b.filter(a => a.type === 'expense').reduce((s, a) => s + a.balance, 0);
    return {
      revenueAccounts: b.filter(a => a.type === 'revenue'),
      expenseAccounts: b.filter(a => a.type === 'expense'),
      revenue: rev,
      expenses: exp,
      netProfit: rev - exp,
    };
  }

  balanceSheet() {
    const b = this.balances();
    const assets = b.filter(a => a.type === 'asset').reduce((s, a) => s + a.balance, 0);
    const liabilities = b.filter(a => a.type === 'liability').reduce((s, a) => s + a.balance, 0);
    const equity = b.filter(a => a.type === 'equity').reduce((s, a) => s + a.balance, 0);
    const pl = this.profitAndLoss();
    const totalEquity = equity + pl.netProfit;
    return {
      assets: b.filter(a => a.type === 'asset'),
      liabilities: b.filter(a => a.type === 'liability'),
      equityAccounts: b.filter(a => a.type === 'equity'),
      totalAssets: assets,
      totalLiabilities: liabilities,
      totalEquity,
      netIncome: pl.netProfit,
      balanced: assets === liabilities + totalEquity,
    };
  }

  verify() {
    const r = this.db.prepare('SELECT SUM(debits_cents) AS d, SUM(credits_cents) AS c FROM journal_lines').get();
    return { debits: r.d || 0, credits: r.c || 0, balanced: (r.d || 0) === (r.c || 0) };
  }
}

export { AccountingService, DEBIT_SIDED };