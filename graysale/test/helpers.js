import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';

// Keep per-request logs out of the TAP output. Set before any HTTP test
// dispatches its first request.
process.env.LOG_REQUESTS = '0';

// Fresh isolated app + DB for every call.
export function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'graysale-test-'));
  return createApp({ dbPath: join(dir, 'test.db') });
}

export function admin(app) {
  return app.auth.login({ username: 'admin', password: 'admin123' }).user;
}

export function standardTax(app) {
  return app.catalog.taxClasses().find((t) => t.name === 'Standard');
}

// A ready catalog: A (within margins) and B (low) products.
export function seedCatalog(app, opts = {}) {
  const catId = app.catalog.createCategory('Groceries');
  const tx = standardTax(app);
  const A = app.catalog.createProduct({
    sku: 'A001',
    barcode: '6000000000001',
    name: 'Product A',
    categoryId: catId,
    unit: 'each',
    costCents: 2000,
    priceCents: 4500,
    taxClassId: tx.id,
    reorderLevel: 5,
  });
  const B = app.catalog.createProduct({
    sku: 'B001',
    barcode: '6000000000002',
    name: 'Product B',
    categoryId: catId,
    unit: 'each',
    costCents: 900,
    priceCents: 1400,
    taxClassId: tx.id,
    reorderLevel: 5,
  });
  const aQty = opts.aQty ?? 10;
  const bQty = opts.bQty ?? 10;
  if (aQty > 0) app.catalog.move({ productId: A.id, qty: aQty, type: 'OPENING', note: 'opening' });
  if (bQty > 0) app.catalog.move({ productId: B.id, qty: bQty, type: 'OPENING', note: 'opening' });
  return { A, B, catId };
}

export function customer(app, name = 'Jane Doe', limit = 500000) {
  return app.customers.create({ name, phone: '000', email: `${name}@example.com`, creditLimitCents: limit });
}

export function supplier(app, name = 'Acme Wholesale') {
  return app.suppliers.create({ name, phone: '000', email: 'acme@example.com', taxId: 'TAX001' });
}

export function assertBalanced(app) {
  const v = app.accounting.verify();
  if (!v.balanced) throw new Error(`Journal UNBALANCED: debits ${v.debits} != credits ${v.credits}`);
  return v;
}
