import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore, productIds } from './helpers.js';
import { createOrchestrator } from '../src/agents/index.js';
import { createMessage } from '../src/agents/message.js';

function newCtx() {
  const store = createTestStore();
  return { store, orch: createOrchestrator(store), ids: productIds(store) };
}

async function handle(orch, domain, payload = {}, type = 'QUERY') {
  return orch.send(createMessage({ type, from: 'test', to: '', domain, payload }));
}

// ---------------- Finance ----------------
test('FIN: get_balance returns account row', async () => {
  const { orch } = newCtx();
  const res = await handle(orch, 'finance.get_balance', { accountCode: '1000' });
  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.data.code, '1000');
});

test('FIN: post balanced journal entry', async () => {
  const { orch } = newCtx();
  const res = await handle(orch, 'finance.post', {
    entryNo: 'JE-TEST-1', reference: 'T', description: 't',
    lines: [{ accountCode: '1000', debits: 1000 }, { accountCode: '4000', credits: 1000 }],
  });
  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.data.balanced, true);
});

test('FIN: post imbalanced journal is still recorded but flagged', async () => {
  const { orch } = newCtx();
  const res = await handle(orch, 'finance.post', {
    entryNo: 'JE-TEST-2', reference: 'T', description: 't',
    lines: [{ accountCode: '1000', debits: 500 }],
  });
  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.data.balanced, false);
});

test('FIN: unknown finance action fails', async () => {
  const { orch } = newCtx();
  const res = await handle(orch, 'finance.bogus');
  assert.equal(res.status, 'FAILURE');
});

test('FIN: trial balance returns accounts after posting', async () => {
  const { orch } = newCtx();
  await handle(orch, 'finance.post', {
    entryNo: 'JE-TB-1', reference: 'T', description: 't',
    lines: [{ accountCode: '1000', debits: 100 }, { accountCode: '4000', credits: 100 }],
  });
  const res = await handle(orch, 'finance.trial_balance');
  assert.equal(res.status, 'SUCCESS');
  assert.ok(res.data.length >= 2);
});

test('FIN: create invoice creates a payable invoice', async () => {
  const { orch, store } = newCtx();
  const res = await handle(orch, 'finance.invoice', {
    type: 'payable',
    partyName: 'Acme Corp',
    items: [{ description: 'Office supplies', qty: 10, unitPriceCents: 500, taxRate: 0.08 }],
    dueDate: '2026-12-31',
  });
  assert.equal(res.status, 'SUCCESS');
  assert.ok(res.data.invoiceId);
  assert.equal(res.data.type, 'payable');
  assert.equal(res.data.totalCents, 5000 + Math.round(5000 * 0.08));
});

test('FIN: process payment on an invoice', async () => {
  const { orch, store } = newCtx();
  const inv = await handle(orch, 'finance.invoice', {
    type: 'ar',
    partyName: 'Customer X',
    items: [{ description: 'Service', qty: 1, unitPriceCents: 10000 }],
  });
  const payRes = await handle(orch, 'finance.pay', {
    invoiceId: inv.data.invoiceId,
    amountCents: 5000,
    method: 'bank_transfer',
  });
  assert.equal(payRes.status, 'SUCCESS');
  assert.equal(payRes.data.newPaidCents, 5000);
  assert.equal(payRes.data.status, 'partial');
});

// ---------------- HR ----------------
test('HR: list employees returns seeded rows', async () => {
  const { orch } = newCtx();
  const res = await handle(orch, 'employee.list');
  assert.equal(res.status, 'SUCCESS');
  assert.ok(res.data.length >= 2);
  assert.ok(res.data.some(e => e.name === 'Alice Johnson'));
});

test('HR: create employee persists to database', async () => {
  const { orch, store } = newCtx();
  const res = await handle(orch, 'employee.create', {
    name: 'Carol Davis', role: 'Analyst', department: 'Finance',
    hourlyRate: 3000, email: 'carol@example.com', phone: '+15553330001',
  });
  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.data.name, 'Carol Davis');
  assert.equal(res.data.role, 'Analyst');
  const dbRow = store.db.prepare('SELECT * FROM employees WHERE name = ?').get('Carol Davis');
  assert.ok(dbRow);
});

test('HR: get employee by id', async () => {
  const { orch } = newCtx();
  const list = await handle(orch, 'employee.list');
  const alice = list.data.find(e => e.name === 'Alice Johnson');
  const res = await handle(orch, 'employee.get', { id: alice.id });
  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.data.name, 'Alice Johnson');
});

test('HR: update employee fields', async () => {
  const { orch } = newCtx();
  const list = await handle(orch, 'employee.list');
  const alice = list.data.find(e => e.name === 'Alice Johnson');
  const res = await handle(orch, 'employee.update', { id: alice.id, role: 'Senior Cashier' });
  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.data.role, 'Senior Cashier');
});

test('HR: calculate payroll returns gross/tax/net', async () => {
  const { orch } = newCtx();
  const list = await handle(orch, 'employee.list');
  const bob = list.data.find(e => e.name === 'Bob Smith');
  const res = await handle(orch, 'payroll.calculate', { employeeId: bob.id, hours: 40, taxRate: 0.25 });
  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.data.gross, 2500 * 40);
  assert.equal(res.data.tax, Math.round(2500 * 40 * 0.25));
  assert.equal(res.data.net, 2500 * 40 - Math.round(2500 * 40 * 0.25));
});

test('HR: run payroll persists records', async () => {
  const { orch, store } = newCtx();
  const list = await handle(orch, 'employee.list');
  const bob = list.data.find(e => e.name === 'Bob Smith');
  const res = await handle(orch, 'payroll.run', {
    entries: [{ employeeId: bob.id, hours: 40, taxRate: 0.25, period: '2026-08' }],
    period: '2026-08',
  });
  assert.equal(res.status, 'SUCCESS');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM payroll WHERE period = ?').get('2026-08').c, 1);
});

test('HR: benefits enrollment persists to database', async () => {
  const { orch, store } = newCtx();
  const list = await handle(orch, 'employee.list');
  const bob = list.data.find(e => e.name === 'Bob Smith');
  const res = await handle(orch, 'benefits.enroll', {
    employeeId: bob.id,
    planName: 'Silver',
    provider: 'HealthCo',
    monthlyCost: 30000,
    employerContribution: 20000,
  });
  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.data.plan_name, 'Silver');
  assert.equal(res.data.provider, 'HealthCo');
  const dbRow = store.db.prepare('SELECT * FROM benefits WHERE employee_id = ?').get(bob.id);
  assert.ok(dbRow);
});

test('HR: list benefits returns enrolled plans', async () => {
  const { orch } = newCtx();
  const res = await handle(orch, 'benefits.list_benefits');
  assert.equal(res.status, 'SUCCESS');
  assert.ok(res.data.length >= 1);
  assert.ok(res.data[0].employee_name);
});

test('HR: compliance check counts employees with benefits', async () => {
  const { orch } = newCtx();
  const res = await handle(orch, 'compliance.check');
  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.data.totalActiveEmployees, 2);
  assert.ok(typeof res.data.compliant === 'boolean');
});

// ---------------- Supply Chain ----------------
test('SCM: check stock returns quantity', async () => {
  const { orch, ids } = newCtx();
  const res = await handle(orch, 'scm.check', { productId: ids[0] });
  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.data.quantity, 100);
});

test('SCM: adjust inventory changes stock and logs movement', async () => {
  const { orch, ids } = newCtx();
  const res = await handle(orch, 'inventory.adjust', { productId: ids[0], delta: 10, type: 'ADJUST', note: 'test' });
  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.data.quantity, 110);
});

test('SCM: adjust below zero fails', async () => {
  const { orch, ids } = newCtx();
  const res = await handle(orch, 'inventory.adjust', { productId: ids[0], delta: -5000 });
  assert.equal(res.status, 'FAILURE');
});

test('SCM: low stock lists items at or below reorder', async () => {
  const { orch, store, ids } = newCtx();
  store.db.prepare('UPDATE inventory SET quantity = 5, reorder_level = 10 WHERE product_id = ?').run(ids[0]);
  const res = await handle(orch, 'inventory.low_stock');
  assert.equal(res.status, 'SUCCESS');
  assert.ok(res.data.some(r => r.id === ids[0]));
});

test('SCM: transfer moves stock between products', async () => {
  const { orch, ids } = newCtx();
  const res = await handle(orch, 'warehouse.transfer', { fromProductId: ids[0], toProductId: ids[1], quantity: 20 });
  assert.equal(res.status, 'SUCCESS');
  const from = await handle(orch, 'scm.check', { productId: ids[0] });
  const to = await handle(orch, 'scm.check', { productId: ids[1] });
  assert.equal(from.data.quantity, 80);
  assert.equal(to.data.quantity, 120);
});

test('SCM: create and track shipment', async () => {
  const { orch, store } = newCtx();
  const createRes = await handle(orch, 'logistics.create', {
    poId: null, supplierId: null, carrier: 'FedEx',
    estimatedArrival: '2026-10-01',
  });
  assert.equal(createRes.status, 'SUCCESS');
  assert.ok(createRes.data.tracking_no);
  const trackRes = await handle(orch, 'logistics.track', { trackingNo: createRes.data.tracking_no });
  assert.equal(trackRes.status, 'SUCCESS');
  assert.equal(trackRes.data.carrier, 'FedEx');
  assert.equal(trackRes.data.status, 'preparing');
});

// ---------------- Procurement ----------------
test('PROC: create then receive a PO adds inventory', async () => {
  const { orch, store, ids } = newCtx();
  const sup = store.db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('VendorX').lastInsertRowid;
  const poRes = await handle(orch, 'po.create', { supplierId: sup, items: [{ productId: ids[2], qty: 50, unitCostCents: 300 }] });
  assert.equal(poRes.status, 'SUCCESS');
  assert.equal(poRes.data.totalCents, 15000);
  assert.ok(poRes.data.poNo.startsWith('PO-'));

  const before = store.getStock(ids[2]).quantity;
  const rec = await handle(orch, 'po.receive', { poId: poRes.data.poId });
  assert.equal(rec.status, 'SUCCESS');
  assert.equal(store.getStock(ids[2]).quantity, before + 50);
});

test('PROC: receive a non-existent PO fails', async () => {
  const { orch } = newCtx();
  const res = await handle(orch, 'po.receive', { poId: 99999 });
  assert.equal(res.status, 'FAILURE');
});

test('PROC: PO number includes random suffix', async () => {
  const { orch, store, ids } = newCtx();
  const sup = store.db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('VendorY').lastInsertRowid;
  const res1 = await handle(orch, 'po.create', { supplierId: sup, items: [{ productId: ids[0], qty: 10, unitCostCents: 100 }] });
  const res2 = await handle(orch, 'po.create', { supplierId: sup, items: [{ productId: ids[0], qty: 10, unitCostCents: 100 }] });
  assert.notEqual(res1.data.poNo, res2.data.poNo, 'PO numbers should be unique');
  assert.ok(res1.data.poNo.startsWith('PO-'));
  assert.ok(res1.data.poNo.match(/PO-\d+-[a-z0-9]+$/), 'PO number format: PO-{timestamp}-{suffix}');
});

test('PROC: cancel PO changes status to cancelled', async () => {
  const { orch, store, ids } = newCtx();
  const sup = store.db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('VendorZ').lastInsertRowid;
  const poRes = await handle(orch, 'po.create', { supplierId: sup, items: [{ productId: ids[0], qty: 10, unitCostCents: 200 }] });
  const cancelRes = await handle(orch, 'po.cancel', { poId: poRes.data.poId });
  assert.equal(cancelRes.status, 'SUCCESS');
  assert.equal(cancelRes.data.status, 'cancelled');
  const dbPo = store.db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poRes.data.poId);
  assert.equal(dbPo.status, 'cancelled');
});

test('PROC: partial receive only receives specified qty', async () => {
  const { orch, store, ids } = newCtx();
  const sup = store.db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('VendorP').lastInsertRowid;
  const poRes = await handle(orch, 'po.create', {
    supplierId: sup,
    items: [{ productId: ids[0], qty: 100, unitCostCents: 250 }],
  });
  const poItems = store.db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(poRes.data.poId);
  const before = store.getStock(ids[0]).quantity;
  const partialRes = await handle(orch, 'po.partial_receive', {
    poId: poRes.data.poId,
    items: [{ poItemId: poItems[0].id, qty: 30 }],
  });
  assert.equal(partialRes.status, 'SUCCESS');
  assert.equal(partialRes.data.fullyReceived, false);
  assert.equal(store.getStock(ids[0]).quantity, before + 30);
  const updatedItem = store.db.prepare('SELECT * FROM purchase_order_items WHERE id = ?').get(poItems[0].id);
  assert.equal(updatedItem.received_qty, 30);
});

test('PROC: 3-way match detects mismatch', async () => {
  const { orch, store, ids } = newCtx();
  const sup = store.db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('VendorX').lastInsertRowid;
  const poRes = await handle(orch, 'po.create', {
    supplierId: sup,
    items: [{ productId: ids[0], qty: 10, unitCostCents: 1000 }],
  });
  const poId = poRes.data.poId;
  // Create an invoice with matching items
  const inv = store.db.prepare(
    `INSERT INTO invoices (invoice_no, type, party_name, subtotal_cents, tax_cents, total_cents, status)
     VALUES (?, 'payable', 'VendorX', ?, 0, ?, 'open')`
  ).run('INV-MATCH-1', 10000, 10000).lastInsertRowid;
  store.db.prepare(
    'INSERT INTO invoice_items (invoice_id, product_id, description, qty, unit_price_cents, line_total_cents, tax_cents) VALUES (?, ?, ?, ?, ?, ?, 0)'
  ).run(inv, ids[0], 'Whole Milk 1L', 10, 1000, 10000);

  const matched = await handle(orch, 'invoice.match_3way', { poId, invoiceId: inv });
  assert.equal(matched.status, 'SUCCESS');
  assert.equal(matched.data.allMatched, true);

  // Now create a mismatched invoice
  const inv2 = store.db.prepare(
    `INSERT INTO invoices (invoice_no, type, party_name, subtotal_cents, tax_cents, total_cents, status)
     VALUES (?, 'payable', 'VendorX', ?, 0, ?, 'open')`
  ).run('INV-MATCH-2', 9999, 9999).lastInsertRowid;
  store.db.prepare(
    'INSERT INTO invoice_items (invoice_id, product_id, description, qty, unit_price_cents, line_total_cents, tax_cents) VALUES (?, ?, ?, ?, ?, ?, 0)'
  ).run(inv2, ids[0], 'Whole Milk 1L', 10, 999, 9990);

  const mismatched = await handle(orch, 'invoice.match_3way', { poId, invoiceId: inv2 });
  assert.equal(mismatched.status, 'SUCCESS');
  assert.equal(mismatched.data.allMatched, false);
});

test('PROC: vendor evaluate returns total spend', async () => {
  const { orch, store } = newCtx();
  const sup = store.db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('VendorX').lastInsertRowid;
  store.db.prepare('INSERT INTO purchase_orders (po_no, supplier_id, total_cents, status) VALUES (?,?,?,?)')
    .run('PO-EV', sup, 5000, 'open');
  const res = await handle(orch, 'vendor.evaluate', { vendorId: sup });
  assert.equal(res.status, 'SUCCESS');
  assert.equal(res.data.totalSpend, 5000);
});

// ---------------- Sales ----------------
test('SALES: create a customer and search for them', async () => {
  const { orch } = newCtx();
  const created = await handle(orch, 'customer.create', { name: 'New Person', phone: '555' });
  assert.equal(created.status, 'SUCCESS');
  assert.ok(created.data.id);
  const search = await handle(orch, 'customer.search', { query: 'New Person' });
  assert.ok(search.data.some(c => c.name === 'New Person'));
});

test('SALES: order history lists sales', async () => {
  const { orch, store, ids } = newCtx();
  store.db.prepare('INSERT INTO sales (receipt_no, subtotal_cents, tax_cents, total_cents, payment_method) VALUES (?,?,?,?,?)')
    .run('000011', 100, 8, 108, 'cash');
  const res = await handle(orch, 'order.history');
  assert.equal(res.status, 'SUCCESS');
  assert.ok(res.data.some(s => s.receipt_no === '000011'));
});

test('SALES: generate quote is persisted to database', async () => {
  const { orch, store, ids } = newCtx();
  const res = await handle(orch, 'quote.generate', {
    customerId: 2,
    customerName: 'Maria Gomez',
    items: [{ productId: ids[0], productName: 'Whole Milk 1L', qty: 2, unitPriceCents: 250, taxRate: 0.08 }],
  });
  assert.equal(res.status, 'SUCCESS');
  assert.ok(res.data.quote_no);
  assert.ok(res.data.id);
  const dbQuote = store.db.prepare('SELECT * FROM quotes WHERE id = ?').get(res.data.id);
  assert.ok(dbQuote);
  assert.equal(dbQuote.totalCents ?? dbQuote.total_cents, 250 * 2 + Math.round(250 * 2 * 0.08));
  const items = store.db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(res.data.id);
  assert.equal(items.length, 1);
});

test('SALES: top products analytics', async () => {
  const { orch, store, ids } = newCtx();
  const saleId = store.db.prepare('INSERT INTO sales (receipt_no, subtotal_cents, tax_cents, total_cents, payment_method) VALUES (?,?,?,?,?)')
    .run('000099', 500, 40, 540, 'cash').lastInsertRowid;
  store.db.prepare('INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price_cents, line_total_cents, tax_cents) VALUES (?,?,?,?,?,?,?)')
    .run(saleId, ids[0], 'Whole Milk 1L', 2, 250, 500, 40);
  const res = await handle(orch, 'analytics.top_products', { limit: 5 });
  assert.equal(res.status, 'SUCCESS');
  assert.ok(res.data.some(r => r.product_id === ids[0]));
});

test('SALES: daily summary returns sales_by_day rows', async () => {
  const { orch, store, ids } = newCtx();
  store.db.prepare(
    "INSERT INTO sales_by_day (sale_date, count, revenue_cents, cost_cents, profit_cents) VALUES (date('now'), 1, 1000, 600, 400)"
  ).run();
  const res = await handle(orch, 'analytics.daily');
  assert.equal(res.status, 'SUCCESS');
  assert.ok(res.data.length >= 1);
  assert.ok(res.data[0].cost_cents !== undefined);
  assert.ok(res.data[0].profit_cents !== undefined);
});
