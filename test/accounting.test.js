import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore, productIds, productByName } from './helpers.js';
import { AccountingService } from '../src/accounting.js';
import { PosService } from '../src/pos.js';

function newAcct() {
  const store = createTestStore();
  return { store, acct: new AccountingService(store), pos: new PosService(store), milk: productByName(store, 'Whole Milk 1L') };
}

test('chart of accounts is seeded with known accounts', () => {
  const { acct } = newAcct();
  const chart = acct.chartOfAccounts();
  assert.ok(chart.length >= 9);
  const codes = chart.map(a => a.code);
  for (const c of ['1000', '1100', '1200', '2000', '3000', '4000', '4100', '4200', '4300']) {
    assert.ok(codes.includes(c), `expected account ${c}`);
  }
});

test('empty ledger verifies as balanced', () => {
  const { acct } = newAcct();
  const v = acct.verifyBalanced();
  assert.equal(v.balanced, true);
});

test('trial balance stays balanced after sales', async () => {
  const { acct, pos, milk } = newAcct();
  await pos.checkout({ items: [{ productId: milk.id, qty: 3 }] });
  await pos.checkout({ items: [{ productId: milk.id, qty: 2 }] });
  const v = acct.verifyBalanced();
  assert.equal(v.balanced, true);
  assert.ok(v.debits > 0);
  const tb = acct.trialBalance();
  assert.ok(tb.length > 0);
});

test('P&L records revenue after a sale', async () => {
  const { pos, acct, milk } = newAcct();
  const before = acct.profitAndLoss();
  await pos.checkout({ items: [{ productId: milk.id, qty: 1 }] });
  const after = acct.profitAndLoss();
  assert.equal(after.revenue, before.revenue + 250);
  assert.equal(after.cogs, before.cogs + 170);
});

test('P&L with date range filters correctly', async () => {
  const { pos, acct, milk } = newAcct();
  await pos.checkout({ items: [{ productId: milk.id, qty: 1 }] });
  const today = new Date().toISOString().slice(0, 10);
  const inRange = acct.profitAndLoss({ startDate: '2000-01-01', endDate: today });
  assert.equal(inRange.revenue, 250);
  const outOfRange = acct.profitAndLoss({ startDate: '2099-01-01', endDate: '2099-12-31' });
  assert.equal(outOfRange.revenue, 0);
});

test('balance sheet balances after sales', async () => {
  const { pos, acct, milk } = newAcct();
  await pos.checkout({ items: [{ productId: milk.id, qty: 2 }] });
  const b = acct.balanceSheet();
  assert.equal(b.balanced, true);
  assert.equal(b.assets, b.liabilities + b.equity);
});

test('balance sheet with date range filters correctly', async () => {
  const { pos, acct, milk } = newAcct();
  await pos.checkout({ items: [{ productId: milk.id, qty: 1 }] });
  const today = new Date().toISOString().slice(0, 10);
  const inRange = acct.balanceSheet({ startDate: '2000-01-01', endDate: today });
  assert.equal(inRange.balanced, true);
  assert.ok(inRange.assets > 0);
  const outOfRange = acct.balanceSheet({ startDate: '2099-01-01', endDate: '2099-12-31' });
  assert.equal(outOfRange.assets, 0);
});

test('ledger lists both debit and credit lines for a sale', async () => {
  const { pos, acct, milk } = newAcct();
  const sale = await pos.checkout({ items: [{ productId: milk.id, qty: 1 }] });
  const ledger = acct.ledger();
  assert.ok(ledger.some(l => l.reference === sale.receiptNo));
  assert.ok(ledger.some(l => l.reference === `COGS-${sale.receiptNo}`));
});

test('ledger filters by account code', async () => {
  const { pos, acct, milk } = newAcct();
  await pos.checkout({ items: [{ productId: milk.id, qty: 1 }] });
  const cashOnly = acct.ledger('1000');
  assert.ok(cashOnly.every(l => l.account_code === '1000'));
  assert.ok(cashOnly.length > 0);
});

test('ledger filters by date range', async () => {
  const { pos, acct, milk } = newAcct();
  await pos.checkout({ items: [{ productId: milk.id, qty: 1 }] });
  const today = new Date().toISOString().slice(0, 10);
  const inRange = acct.ledger(null, { startDate: '2000-01-01', endDate: today });
  assert.ok(inRange.length > 0);
  const outOfRange = acct.ledger(null, { startDate: '2099-01-01', endDate: '2099-12-31' });
  assert.equal(outOfRange.length, 0);
});

test('account balance reflects sale activity on cash and revenue', async () => {
  const { pos, acct, milk } = newAcct();
  await pos.checkout({ items: [{ productId: milk.id, qty: 1 }] });
  const cash = acct.accountBalance('1000');
  const revenue = acct.accountBalance('4000');
  const tax = acct.accountBalance('4200');
  const expectedTotal = 250 + Math.round(250 * 0.08);
  assert.equal(cash.balance_cents, expectedTotal);
  assert.equal(revenue.balance_cents, 250);
  assert.equal(tax.balance_cents, Math.round(250 * 0.08));
});

test('agingBuckets returns AR/AP bucket structure with no open invoices', () => {
  const { acct } = newAcct();
  const aging = acct.agingBuckets();
  assert.ok(aging.accountsReceivable);
  assert.ok(aging.accountsPayable);
  assert.ok(aging.accountsReceivable.buckets);
  assert.ok(aging.accountsReceivable.totals);
  assert.equal(aging.accountsReceivable.buckets.current.length, 0);
});

test('agingBuckets categorizes invoices by age', async () => {
  const { store, acct } = newAcct();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  store.db.prepare(
    `INSERT INTO invoices (invoice_no, type, party_name, subtotal_cents, tax_cents, total_cents, status, created_at)
     VALUES ('INV-TEST-1', 'receivable', 'Test Customer', 10000, 800, 10800, 'open', ?)`
  ).run(yesterday);
  const aging = acct.agingBuckets();
  assert.equal(aging.accountsReceivable.buckets.current.length, 1);
  assert.equal(aging.accountsReceivable.totals.current.outstanding_cents, 10800);
});

test('taxSummary returns correct structure after sales', async () => {
  const { pos, acct, milk } = newAcct();
  await pos.checkout({ items: [{ productId: milk.id, qty: 1 }] });
  const summary = acct.taxSummary();
  assert.ok(summary.totalTax > 0);
  assert.ok(Array.isArray(summary.byMonth));
  assert.ok(Array.isArray(summary.byCategory));
});

test('taxSummary filters by date range', async () => {
  const { pos, acct, milk } = newAcct();
  await pos.checkout({ items: [{ productId: milk.id, qty: 1 }] });
  const outOfRange = acct.taxSummary({ startDate: '2099-01-01', endDate: '2099-12-31' });
  assert.equal(outOfRange.totalTax, 0);
});

test('profitMargins returns margins by category and product after sales', async () => {
  const { pos, acct, milk } = newAcct();
  await pos.checkout({ items: [{ productId: milk.id, qty: 3 }] });
  const margins = acct.profitMargins();
  assert.ok(margins.byCategory.length > 0);
  assert.ok(margins.byProduct.length > 0);
  assert.ok(margins.byCategory[0].margin_cents !== undefined);
  assert.ok(margins.byCategory[0].margin_pct !== undefined);
  const dairy = margins.byCategory.find(c => c.category === 'Dairy');
  assert.ok(dairy);
  assert.ok(dairy.revenue_cents > 0);
  assert.ok(dairy.cost_cents > 0);
});

test('profitMargins is empty with no sales', () => {
  const { acct } = newAcct();
  const margins = acct.profitMargins();
  assert.equal(margins.byCategory.length, 0);
  assert.equal(margins.byProduct.length, 0);
});
