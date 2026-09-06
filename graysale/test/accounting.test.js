import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, seedCatalog, admin } from './helpers.js';
import { AccountingService } from '../src/services/accounting.js';

test('accounting helper debit/credit side mapping', () => {
  assert.deepEqual(AccountingService.lineFor('asset', 100), { debit_cents: 100, credit_cents: 0 });
  assert.deepEqual(AccountingService.lineFor('revenue', 100), { debit_cents: 0, credit_cents: 100 });
});

test('arbitrary balanced journal entry posts and shows in ledger', () => {
  const app = makeApp();
  const e = app.accounting.postEntry({
    date: '2026-09-01',
    description: 'test', reference: 'X',
    lines: [{ code: '1000', amount: 1000 }, { code: '4000', amount: 1000 }],
    user: admin(app),
  });
  assert.ok(e.id);
  assert.equal(e.reference, 'X');
  assert.equal(app.accounting.verify().balanced, true);
});

test('unbalanced entry is rejected', () => {
  const app = makeApp();
  assert.throws(() => app.accounting.postEntry({
    date: '2026-09-01', description: 'bad', reference: 'B',
    lines: [{ code: '1000', amount: 1000 }, { code: '4000', amount: 900 }], user: admin(app),
  }), /UNBALANCED/);
});

test('trial balance totals equal and balance sheet balances', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  app.pos.checkout({ items: [{ productId: A.id, qty: 1 }], payments: [{ method: 'CASH', amount: 99999 }], user: admin(app) });

  const tb = app.accounting.trialBalance();
  const d = tb.reduce((s, x) => s + (x.debits || 0), 0);
  const c = tb.reduce((s, x) => s + (x.credits || 0), 0);
  assert.equal(d, c);
  assert.equal(app.accounting.verify().balanced, true);
  assert.equal(app.accounting.balanceSheet().balanced, true);
});

test('P&L reflects revenue and COGS', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  app.pos.checkout({ items: [{ productId: A.id, qty: 1 }], payments: [{ method: 'CASH', amount: 99999 }], user: admin(app) });
  const pl = app.accounting.profitAndLoss();
  assert.equal(pl.revenue, 4500);
  assert.equal(pl.expenses, 2000);
  assert.equal(pl.netProfit, 2500);
});