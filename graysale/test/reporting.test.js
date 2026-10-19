import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, seedCatalog, admin, assertBalanced } from './helpers.js';

test('sale â†’ refund net in reports stays coherent (no negative sales)', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  const u = admin(app);

  const sale = app.pos.checkout({
    items: [{ productId: A.id, qty: 2 }],
    payments: [{ method: 'CASH', amount: 50000 }],
    user: u,
  });
  const sum = app.reports.salesSummary();
  assert.equal(sum.saleCount, 1);
  assert.equal(sum.netSales, 10350);

  app.pos.refund({ saleId: sale.id, items: [{ productId: A.id, qty: 1 }], method: 'CASH', reason: 'test', user: u });
  const after = app.reports.salesSummary();
  assert.equal(after.refundTotal, -5175);
  assert.equal(after.netSales, 5175);
  assertBalanced(app);
});

test('dead stock reports products with stock but no movement', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  const dead = app.reports.deadStock(1);
  assert.ok(dead.some((x) => x.id === A.id));
});
