import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, seedCatalog, admin } from './helpers.js';

test('purchase order â†’ place â†’ receive creates AP bill, increases stock, recosts', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  const supId = app.suppliers.create({ name: 'Acme Wholesale' });

  const po = app.purchasing.createPo({
    supplierId: supId,
    items: [{ productId: A.id, qty: 20, unitCostCents: 2500 }],
    user: admin(app),
  });
  assert.equal(po.status, 'DRAFT');
  assert.equal(po.total_cents, 57500); // 50000 + 15% tax
  app.purchasing.placePo(po.id);
  const r = app.purchasing.receivePo({ poId: po.id, items: [{ productId: A.id, qty: 20 }], user: admin(app) });

  // stock increased 10 -> 30
  assert.equal(app.catalog.getProduct(A.id).qty_on_hand, 30);
  // AP bill created and open
  assert.equal(r.bill.status, 'OPEN');
  assert.equal(r.bill.total_cents, 57500);
  // weighted average recost: (2000*10 + 2500*20)/30 = 2333
  assert.equal(app.catalog.getProduct(A.id).cost_cents, 2333);
  assert.equal(app.accounting.verify().balanced, true);
});

test('buyer payment to supplier reduces AP and books balanced', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  const supId = app.suppliers.create({ name: 'Acme Wholesale' });
  const po = app.purchasing.createPo({
    supplierId: supId,
    items: [{ productId: A.id, qty: 10, unitCostCents: 2000 }],
    user: admin(app),
  });
  app.purchasing.placePo(po.id);
  const r = app.purchasing.receivePo({ poId: po.id, items: [{ productId: A.id, qty: 10 }], user: admin(app) });

  const pay = app.payments.paySupplier({
    supplierId: supId,
    method: 'BANK',
    amount: r.bill.total_cents,
    user: admin(app),
  });
  assert.equal(pay.kind, 'EXPENSE');
  assert.equal(app.invoicing.getAp(r.bill.id).status, 'PAID');
  assert.equal(app.accounting.verify().balanced, true);
});

test('customer receipt allocates to AR invoice', () => {
  const app = makeApp();
  const cid = app.customers.create({ name: 'Cust' });
  const inv = app.invoicing.createArInvoice({ customerId: cid, subtotalCents: 10000, taxCents: 1500 });
  assert.equal(inv.total_cents, 11500);

  const rec = app.payments.receivePayment({ customerId: cid, method: 'CASH', amount: 11500, user: admin(app) });
  assert.equal(rec.kind, 'RECEIPT');
  assert.equal(app.invoicing.getAr(inv.id).status, 'PAID');
  assert.equal(app.customers.get(cid).outstanding_cents, 0);
  assert.equal(app.accounting.verify().balanced, true);
});

test('credit note reduces customer balance', () => {
  const app = makeApp();
  const cid = app.customers.create({ name: 'Cust' });
  app.invoicing.createArInvoice({ customerId: cid, subtotalCents: 5000, taxCents: 750 });
  const cn = app.invoicing.createCreditNote({ customerId: cid, subtotalCents: 5000, taxCents: 750 });
  // credit note has negative total
  assert.equal(cn.total_cents, -5750);
  assert.equal(app.customers.ledger(cid).outstanding, 0);
});
