import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, seedCatalog, customer, supplier, admin, assertBalanced } from './helpers.js';

test('AR invoice then receipt; credit note reduces balance', () => {
  const app = makeApp();
  const cid = customer(app);
  const user = admin(app);

  const inv = app.invoicing.createArInvoice({ customerId: cid, subtotalCents: 4500, taxCents: 675 });
  assert.equal(inv.total_cents, 5175);
  assert.equal(inv.status, 'OPEN');
  assert.equal(app.invoicing.arOutstanding(cid), 5175);
  assertBalanced(app);

  const r = app.payments.receivePayment({ customerId: cid, amount: 2000, method: 'CASH', user });
  assert.equal(r.allocations.length, 1);
  assert.equal(app.invoicing.arOutstanding(cid), 5175 - 2000);
  assert.equal(app.invoicing.getAr(inv.id).paid_cents, 2000);
  assertBalanced(app);

  const cn = app.invoicing.createCreditNote({ customerId: cid, subtotalCents: 1000, taxCents: 150, note: 'courtesy' });
  assert.equal(cn.kind, 'CREDIT_NOTE');
  assert.equal(cn.total_cents, -1150);
  assertBalanced(app);
});

test('PO lifecycle: draft -> ordered -> received (stock up, AP bill, balanced)', () => {
  const app = makeApp();
  const { A } = seedCatalog(app, { aQty: 0, bQty: 0 });
  const sid = supplier(app);
  const user = admin(app);

  const po = app.purchasing.createPo({
    supplierId: sid,
    items: [{ productId: A.id, qty: 10, unitCostCents: 1800 }],
    expectedDate: '2026-12-31',
    user,
  });
  assert.equal(po.status, 'DRAFT');
  assert.equal(po.total_cents, 20700);

  assert.equal(app.purchasing.placePo(po.id).status, 'ORDERED');

  const gr = app.purchasing.receivePo({ poId: po.id, items: [{ productId: A.id, qty: 10 }], user });
  assert.match(gr.grNo, /^GR-/);
  assert.match(gr.bill.doc_no, /^BILL-/);
  assert.equal(app.catalog.qtyOnHand(A.id).qty_on_hand, 10);

  const bill = app.invoicing.getAp(gr.bill.id);
  assert.equal(bill.status, 'OPEN');
  assert.equal(bill.total_cents, 20700, '18000 + 15% tax');
  assert.equal(app.suppliers.ledger(sid).owing, 20700);
  assertBalanced(app);

  // weighted average cost is updated
  assert.equal(app.catalog.getProduct(A.id).cost_cents, 1800);

  // over-receipt rejected
  assert.throws(
    () => app.purchasing.receivePo({ poId: po.id, items: [{ productId: A.id, qty: 1 }], user }),
    /NOT_ORDERED/,
  );
});

test('pay supplier settles AP and posts to chosen method', () => {
  const app = makeApp();
  const { A } = seedCatalog(app, { aQty: 0 });
  const sid = supplier(app);
  const user = admin(app);

  const po = app.purchasing.createPo({
    supplierId: sid,
    items: [{ productId: A.id, qty: 5, unitCostCents: 2000 }],
    user,
  });
  app.purchasing.placePo(po.id);
  const { bill } = app.purchasing.receivePo({ poId: po.id, items: [{ productId: A.id, qty: 5 }], user });
  assert.equal(app.suppliers.ledger(sid).owing, 11500);

  const p = app.payments.paySupplier({ supplierId: sid, amount: 11500, method: 'BANK', user });
  assert.equal(p.kind, 'EXPENSE');
  assert.equal(app.invoicing.getAp(bill.id).status, 'PAID');
  assert.equal(app.suppliers.ledger(sid).owing, 0);
  assertBalanced(app);
});

test('bank account is created on demand and reconciles manual entries', () => {
  const app = makeApp();
  assert.equal(app.banks.accounts().length, 0, 'no bank account seeded');
  const id = app.banks.addManual({ date: '2026-08-01', memo: 'seed cash', amount: 100000 });
  assert.ok(id > 0);
  const acct = app.banks.accounts()[0];
  assert.ok(acct, 'default bank account auto-created');
  const recId = app.banks.reconcile({
    bankAccountId: acct.id,
    statementDate: '2026-08-31',
    closingBalance: 100000,
    transactionIds: [id],
  });
  assert.ok(recId > 0);
  const txs = app.banks.transactions({ reconciled: true });
  assert.equal(txs.length, 1);
});

test('EOD shift: opening float, cash flows, variance on close', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  const user = admin(app);

  const sh = app.eod.open({ user, openingCashCents: 5000 });
  assert.equal(sh.status, 'OPEN');

  // a second open shift for the same cashier is blocked
  assert.throws(() => app.eod.open({ user: admin(app), openingCashCents: 0 }), /SHIFT_ALREADY_OPEN/);

  const sale = app.pos.checkout({
    items: [{ productId: A.id, qty: 1 }],
    payments: [{ method: 'CASH', amount: 6000 }],
    user,
  });
  assert.equal(sale.change, 825);

  const closed = app.eod.close({ shiftId: sh.id, countedCashCents: 5000 + 5175, note: 'all good', user });
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.expected_cash_cents, 10175);
  assert.equal(closed.variance_cents, 0);

  // cashier is free again
  const sh2 = app.eod.open({ user: admin(app), openingCashCents: 100 });
  assert.equal(sh2.status, 'OPEN');
  app.eod.close({ shiftId: sh2.id, countedCashCents: 100 });
  assertBalanced(app);
});

test('reporting slices the same journal the GL does', () => {
  const app = makeApp();
  const { A, B } = seedCatalog(app);
  const user = admin(app);
  app.pos.checkout({
    items: [
      { productId: A.id, qty: 1 },
      { productId: B.id, qty: 2 },
    ],
    payments: [{ method: 'CASH', amount: 10000 }],
    user,
  });

  const r = app.reports.salesSummary({ from: '2026-01-01', to: '2026-12-31' });
  assert.equal(r.saleCount, 1);
  assert.equal(r.netSales, 8395);
  const pl = app.accounting.profitAndLoss();
  assert.equal(pl.netProfit, 7300 - (2000 + 2 * 900));
  const bs = app.accounting.balanceSheet();
  assert.equal(bs.balanced, true, 'assets = liabilities + equity(+PnL)');
  assertBalanced(app);
});
