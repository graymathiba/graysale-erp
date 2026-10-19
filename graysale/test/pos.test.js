import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, seedCatalog, customer, admin, assertBalanced } from './helpers.js';

// 15% VAT on product prices: 2xA(4500) + 3xB(1400) = 13200 gross, 1980 tax, 15180 total.

test('cash sale computes totals, drops stock, posts and balances the journal', () => {
  const app = makeApp();
  const { A, B } = seedCatalog(app);
  const user = admin(app);

  const sale = app.pos.checkout({
    items: [
      { productId: A.id, qty: 2 },
      { productId: B.id, qty: 3 },
    ],
    payments: [{ method: 'CASH', amount: 16000 }],
    user,
  });

  assert.equal(sale.total_cents, 15180);
  assert.equal(sale.change, 820);
  assert.equal(sale.status, 'PAID');
  assert.equal(sale.lines.length, 2);
  assert.equal(sale.doc_no, 'SALE-00001');
  assert.equal(app.catalog.qtyOnHand(A.id).qty_on_hand, 8);
  assert.equal(app.catalog.qtyOnHand(B.id).qty_on_hand, 7);

  const v = assertBalanced(app);
  const bal = app.accounting.balances();
  assert.ok(v.debits > 0);
  assert.equal(bal.find((a) => a.code === '1000').balance, 15180, 'cash reflects amount applied after change');
});

test('underpayment is rejected, overpayment returns change', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);

  assert.throws(
    () =>
      app.pos.checkout({
        items: [{ productId: A.id, qty: 1 }],
        payments: [{ method: 'CASH', amount: 5000 }],
        user: admin(app),
      }),
    /UNPAID/,
  );

  const sale = app.pos.checkout({
    items: [{ productId: A.id, qty: 1 }],
    payments: [{ method: 'CASH', amount: 6000 }],
    user: admin(app),
  });
  assert.equal(sale.total_cents, 5175);
  assert.equal(sale.change, 825);
});

test('invalid payment method and negative amounts are rejected', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  const user = admin(app);
  assert.throws(
    () => app.pos.checkout({ items: [{ productId: A.id, qty: 1 }], payments: [{ method: 'BTC', amount: 5175 }], user }),
    /INVALID_PAYMENT_METHOD/,
  );
  assert.throws(
    () => app.pos.checkout({ items: [{ productId: A.id, qty: 1 }], payments: [{ method: 'CASH', amount: -1 }], user }),
    /NEGATIVE_PAYMENT/,
  );
});

test('card sale credits an unbundled bank GL account', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  const sale = app.pos.checkout({
    items: [{ productId: A.id, qty: 1 }],
    payments: [{ method: 'CARD', amount: 5175 }],
    user: admin(app),
  });
  assert.equal(sale.total_cents, 5175);
  const autoBank = app.accounting.accountByCode('1010');
  assert.equal(app.accounting.balances().find((a) => a.id === autoBank.id).balance, 5175);
  assertBalanced(app);
});

test('credit sale posts AR when customer exists and respects credit limit', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  const cid = customer(app, 'Charge Along', 500000);
  const user = admin(app);

  const sale = app.pos.checkout({
    items: [{ productId: A.id, qty: 2 }],
    payments: [{ method: 'CREDIT', amount: 10350 }],
    customerId: cid,
    user,
  });
  assert.equal(sale.total_cents, 10350);
  assert.equal(app.invoicing.arOutstanding(cid), 10350);
  assert.equal(app.pos.getOrder(sale.id).invoices.length, 1);

  // limit exceeded -> conflict (payment must cover the total so UNPAID passes first)
  assert.throws(
    () =>
      app.pos.checkout({
        items: [{ productId: A.id, qty: 1 }],
        payments: [{ method: 'CREDIT', amount: 2070000 }],
        customerId: cid,
        user,
      }),
    /CREDIT_LIMIT/,
  );
  assertBalanced(app);
});

test('refund restores stock and cash, stays balanced', () => {
  const app = makeApp();
  const { A, B } = seedCatalog(app);
  const user = admin(app);

  const sale = app.pos.checkout({
    items: [
      { productId: A.id, qty: 2 },
      { productId: B.id, qty: 3 },
    ],
    payments: [{ method: 'CASH', amount: 16000 }],
    user,
  });

  const rf = app.pos.refund({
    saleId: sale.id,
    items: [{ productId: A.id, qty: 1 }],
    method: 'CASH',
    reason: 'damaged',
    user,
  });
  assert.equal(rf.type, 'REFUND');
  assert.equal(rf.total_cents, -5175);
  assert.equal(app.pos.getOrder(sale.id).refunded_cents, 5175);
  assert.equal(app.catalog.qtyOnHand(A.id).qty_on_hand, 9);
  assertBalanced(app);

  // cannot refund more than sold
  const sale2 = app.pos.checkout({
    items: [{ productId: B.id, qty: 1 }],
    payments: [{ method: 'CASH', amount: 1610 }],
    user,
  });
  assert.throws(
    () => app.pos.refund({ saleId: sale2.id, items: [{ productId: B.id, qty: 2 }], method: 'CASH', user }),
    /INVALID_QTY|REFUND_EXCEEDS/,
  );
});

test('layaway reserves stock, finalize sells and balances', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  const cid = customer(app);
  const user = admin(app);

  const la = app.pos.createLayaway({ customerId: cid, items: [{ productId: A.id, qty: 2 }], deposit: 3000, user });
  assert.equal(la.status, 'OPEN');
  assert.equal(la.total_cents, 10350);
  assert.equal(app.catalog.qtyOnHand(A.id).qty_on_hand, 10);
  assert.equal(app.catalog.available(A.id), 8, 'two units reserved');

  const done = app.pos.finalizeLayaway(la.id, [{ method: 'CASH', amount: 7350 }], user);
  assert.equal(done.status, 'COMPLETED');
  assert.equal(app.catalog.available(A.id), 8, 'reservation released and 2 sold');
  assert.equal(app.catalog.qtyOnHand(A.id).qty_on_hand, 8);
  assertBalanced(app);
});

test('layaway cancel refunds deposit and releases goods', () => {
  const app = makeApp();
  const { B } = seedCatalog(app);
  const cid = customer(app);
  const user = admin(app);

  const la = app.pos.createLayaway({ customerId: cid, items: [{ productId: B.id, qty: 1 }], deposit: 1000, user });
  assert.equal(app.catalog.available(B.id), 9);
  const vo = app.pos.cancelLayaway(la.id, user);
  assert.equal(vo.status, 'VOID');
  assert.equal(app.catalog.available(B.id), 10);
  assertBalanced(app);
});

test('quote converts into a paying sale', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  const cid = customer(app);
  const user = admin(app);

  const q = app.pos.createQuote({ customerId: cid, items: [{ productId: A.id, qty: 1 }], user });
  assert.equal(q.type, 'QUOTE');
  assert.equal(q.total_cents, 5175);

  const sale = app.pos.convertQuote(q.id, [{ method: 'CASH', amount: 5175 }], user);
  assert.equal(sale.type, 'SALE');
  assert.equal(sale.total_cents, 5175);
  assert.equal(app.pos.getOrder(q.id).status, 'CONVERTED');
  assert.equal(app.catalog.qtyOnHand(A.id).qty_on_hand, 9);
  assertBalanced(app);
});

test('cannot sell more than available stock', () => {
  const app = makeApp();
  const { A } = seedCatalog(app, { aQty: 2 });
  assert.throws(
    () =>
      app.pos.checkout({
        items: [{ productId: A.id, qty: 3 }],
        payments: [{ method: 'CASH', amount: 99999 }],
        user: admin(app),
      }),
    /INSUFFICIENT_STOCK/,
  );
  assertBalanced(app);
});

test('document numbering is sequential across types', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  const u = admin(app);
  app.pos.checkout({ items: [{ productId: A.id, qty: 1 }], payments: [{ method: 'CASH', amount: 5175 }], user: u });
  app.pos.checkout({ items: [{ productId: A.id, qty: 1 }], payments: [{ method: 'CASH', amount: 5175 }], user: u });
  const orders = app.pos.orders({ type: 'SALE' });
  assert.deepEqual(
    orders.map((o) => o.doc_no),
    ['SALE-00002', 'SALE-00001'],
  );
});
