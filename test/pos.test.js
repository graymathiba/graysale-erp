import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore, productIds, productByName } from './helpers.js';
import { PosService } from '../src/pos.js';

function newPos() {
  const store = createTestStore();
  return { store, pos: new PosService(store), milk: productByName(store, 'Whole Milk 1L'), ids: productIds(store) };
}

test('checkout completes a sale and returns receipt', async () => {
  const { store, pos, milk } = newPos();
  const result = await pos.checkout({ items: [{ productId: milk.id, qty: 2 }] });
  assert.equal(result.ok, true);
  assert.equal(result.receiptNo.length, 6);
  assert.equal(result.subtotalCents, 250 * 2);
  assert.equal(result.taxCents, Math.round(250 * 2 * 0.08));
  assert.equal(result.totalCents, 250 * 2 + Math.round(250 * 2 * 0.08));

  const sale = store.db.prepare('SELECT * FROM sales WHERE receipt_no = ?').get(result.receiptNo);
  assert.ok(sale);
  assert.equal(sale.status, 'complete');
});

test('checkout deducts inventory and records a movement', async () => {
  const { store, pos, ids } = newPos();
  const startQty = store.getStock(ids[0]).quantity;
  await pos.checkout({ items: [{ productId: ids[0], qty: 5 }] });
  assert.equal(store.getStock(ids[0]).quantity, startQty - 5);
  const movements = store.db.prepare('SELECT * FROM inventory_movements WHERE product_id = ? AND type = ?').all(ids[0], 'SALE');
  assert.equal(movements.length, 1);
  assert.equal(movements[0].quantity, -5);
});

test('checkout rejects insufficient stock', async () => {
  const { store, pos, ids } = newPos();
  const result = await pos.checkout({ items: [{ productId: ids[0], qty: 9999 }] });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('INSUFFICIENT_STOCK'));
});

test('checkout with insufficient cash is rejected', async () => {
  const { pos, ids } = newPos();
  const result = await pos.checkout({ items: [{ productId: ids[0], qty: 1 }], cashReceivedCents: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INSUFFICIENT_CASH');
});

test('checkout posts balanced double-entry journal', async () => {
  const { store, pos, ids } = newPos();
  await pos.checkout({ items: [{ productId: ids[0], qty: 1 }] });
  const row = store.db.prepare('SELECT SUM(debits_cents) AS d, SUM(credits_cents) AS c FROM journal_lines').get();
  assert.equal(row.d, row.c);
});

test('checkout awards and deducts loyalty points for a customer', async () => {
  const { store, pos, ids } = newPos();
  const before = store.db.prepare('SELECT * FROM customers WHERE id = 2').get();
  const result = await pos.checkout({ items: [{ productId: ids[0], qty: 2 }], customerId: 2, redeemPoints: 100 });
  const after = store.db.prepare('SELECT * FROM customers WHERE id = 2').get();
  assert.equal(after.loyalty_points, before.loyalty_points - 100 + result.loyaltyPointsEarned);
  assert.equal(after.total_spent_cents, before.total_spent_cents + result.totalCents);
});

test('checkout posts COGS journal entry', async () => {
  const { store, pos, ids } = newPos();
  await pos.checkout({ items: [{ productId: ids[0], qty: 2 }] });
  const cogsEntries = store.db.prepare("SELECT * FROM journal_entries WHERE reference LIKE 'COGS-%'").all();
  assert.ok(cogsEntries.length >= 1);
  const cogsLines = store.db.prepare('SELECT * FROM journal_lines WHERE entry_id = ?').get(cogsEntries[0].id);
  assert.ok(cogsLines);
});

test('split payment checkout succeeds with multiple payment methods', async () => {
  const { pos, milk } = newPos();
  const result = await pos.checkout({
    items: [{ productId: milk.id, qty: 2 }],
    payments: [
      { method: 'cash', amountCents: 250 },
      { method: 'card', amountCents: 250 + Math.round(250 * 2 * 0.08) - 250 },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.totalCents, 250 * 2 + Math.round(250 * 2 * 0.08));
});

test('void restores inventory and reverses journal including COGS', async () => {
  const { store, pos, ids } = newPos();
  const startQty = store.getStock(ids[0]).quantity;
  const sale = await pos.checkout({ items: [{ productId: ids[0], qty: 4 }] });
  const debitsBefore = store.db.prepare('SELECT SUM(debits_cents) AS d FROM journal_lines').get().d;
  const result = pos.voidSale(sale.saleId, 'test');
  assert.equal(result.ok, true);
  assert.equal(store.getStock(ids[0]).quantity, startQty);
  const dbRow = store.db.prepare('SELECT * FROM sales WHERE id = ?').get(sale.saleId);
  assert.equal(dbRow.status, 'void');
  const row = store.db.prepare('SELECT SUM(debits_cents) AS d, SUM(credits_cents) AS c FROM journal_lines').get();
  assert.equal(row.d, row.c);
  // COGS reversal: debits and credits should still be balanced
  const cogsReversals = store.db.prepare("SELECT * FROM journal_entries WHERE reference LIKE 'COGS-%'").all();
  assert.ok(cogsReversals.length >= 2); // original COGS + reversal
  const cogsAccount = store.db.prepare("SELECT * FROM accounts WHERE code = '4100'").get();
  assert.equal(cogsAccount.balance_cents, 0); // original + reversal = net zero
});

test('void on a non-existent sale returns not found', async () => {
  const { pos } = newPos();
  const result = pos.voidSale(999999, 'test');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'NOT_FOUND');
});

test('void of an already-void sale is rejected', async () => {
  const { store, pos, ids } = newPos();
  const sale = await pos.checkout({ items: [{ productId: ids[0], qty: 1 }] });
  pos.voidSale(sale.saleId, 'first');
  const result = pos.voidSale(sale.saleId, 'second');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ALREADY_VOID');
});

test('checkout with no items is rejected', async () => {
  const { pos } = newPos();
  const result = await pos.checkout({ items: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'NO_ITEMS');
});

test('sales_by_day has cost_cents and profit_cents populated after checkout', async () => {
  const { store, pos, milk } = newPos();
  await pos.checkout({ items: [{ productId: milk.id, qty: 2 }] });
  const day = new Date().toISOString().slice(0, 10);
  const agg = store.db.prepare('SELECT * FROM sales_by_day WHERE sale_date = ?').get(day);
  assert.ok(agg);
  assert.ok(agg.revenue_cents > 0, 'revenue_cents should be populated');
  assert.ok(agg.cost_cents > 0, 'cost_cents should be populated');
  assert.equal(agg.profit_cents, agg.revenue_cents - agg.cost_cents, 'profit_cents = revenue - cost');
});

test('void decrements sales_by_day cost and profit', async () => {
  const { store, pos, milk } = newPos();
  await pos.checkout({ items: [{ productId: milk.id, qty: 1 }] });
  const day = new Date().toISOString().slice(0, 10);
  const before = store.db.prepare('SELECT * FROM sales_by_day WHERE sale_date = ?').get(day);
  const sale = await pos.checkout({ items: [{ productId: milk.id, qty: 1 }] });
  const mid = store.db.prepare('SELECT * FROM sales_by_day WHERE sale_date = ?').get(day);
  assert.ok(mid.cost_cents > before.cost_cents);
  pos.voidSale(sale.saleId, 'test');
  const after = store.db.prepare('SELECT * FROM sales_by_day WHERE sale_date = ?').get(day);
  assert.equal(after.cost_cents, before.cost_cents);
  assert.equal(after.profit_cents, before.profit_cents);
});

test('checkout with card payment succeeds', async () => {
  const { store, pos, ids } = newPos();
  const result = await pos.checkout({
    items: [{ productId: ids[0], qty: 1 }],
    paymentMethod: 'card',
    cashReceivedCents: null,
  });
  assert.equal(result.ok, true);
  const sale = store.db.prepare('SELECT * FROM sales WHERE receipt_no = ?').get(result.receiptNo);
  assert.equal(sale.payment_method, 'card');
});
