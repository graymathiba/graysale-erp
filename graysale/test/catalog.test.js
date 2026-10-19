import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, seedCatalog, standardTax } from './helpers.js';

test('creates categories and products with tax wiring', () => {
  const app = makeApp();
  const { A, catId } = seedCatalog(app);
  const cats = app.catalog.categories();
  assert.equal(cats.length, 1);
  assert.equal(cats[0].id, catId);
  assert.equal(A.name, 'Product A');
  assert.equal(A.price_cents, 4500);
  assert.equal(A.tax_rate_bps, 1500);
  assert.equal(app.catalog.getProduct(A.id).qty_on_hand, 10);
  assert.equal(app.catalog.qtyOnHand(A.id).qty_reserved, 0);
});

test('lookup by barcode and sku resolves the same product', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  assert.equal(app.catalog.findByBarcode(A.barcode).id, A.id);
  assert.equal(app.catalog.findBySku(A.sku).id, A.id);
  assert.equal(app.catalog.findByBarcode('999999999'), null);
});

test('duplicate sku / barcode is rejected', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  assert.throws(() => app.catalog.createProduct({ sku: A.sku, name: 'Dup' }), /SKU_EXISTS/);
  assert.throws(() => app.catalog.createProduct({ sku: 'X2', barcode: A.barcode, name: 'Dup' }), /BARCODE_EXISTS/);
});

test('stock movements move qty and record history', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  app.catalog.move({ productId: A.id, qty: 5, type: 'RECEIPT', note: 'restock' });
  assert.equal(app.catalog.qtyOnHand(A.id).qty_on_hand, 15);
  const movs = app.catalog.movements({ productId: A.id });
  assert.equal(movs.length, 2);
  assert.ok(movs.every((m) => m.product_id === A.id));
});

test('reserve/release affects available but not on-hand', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  app.catalog.reserve(A.id, 3, 'order', 1);
  assert.equal(app.catalog.available(A.id), 7);
  assert.equal(app.catalog.qtyOnHand(A.id).qty_on_hand, 10);
  app.catalog.release(A.id, 3, 'order', 1);
  assert.equal(app.catalog.available(A.id), 10);
});

test('low stock screen flags products at or below reorder level', () => {
  const app = makeApp();
  const { B } = seedCatalog(app, { aQty: 40, bQty: 2 });
  const low = app.catalog.lowStock();
  assert.equal(low.length, 1);
  assert.equal(low[0].id, B.id);
});

test('product updates persist and validate active flag', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  app.catalog.updateProduct(A.id, { priceCents: 5000, active: 0 });
  const p = app.catalog.getProduct(A.id);
  assert.equal(p.price_cents, 5000);
  assert.equal(p.active, 0);
});

test('product updates accept boolean flags and serialize them to 0/1', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  app.catalog.updateProduct(A.id, { serialTracked: true, active: false, reorderLevel: 3 });
  const p = app.catalog.getProduct(A.id);
  assert.equal(p.serial_tracked, 1);
  assert.equal(p.active, 0);
  assert.equal(p.reorder_level, 3);
});

test('standard tax class seeded at 15%', () => {
  const app = makeApp();
  const st = standardTax(app);
  assert.equal(st.rate_bps, 1500);
});

test('empty-string FK references are treated as unset (no FK violation)', () => {
  const app = makeApp();
  const p = app.catalog.createProduct({ sku: 'EMPTY-CAT', name: 'No category', categoryId: '', barcode: '' });
  assert.equal(p.category_id, null);
  assert.equal(p.barcode, null);
  const { A } = seedCatalog(app);
  app.catalog.updateProduct(A.id, { categoryId: '', priceCents: 5500 });
  const updated = app.catalog.getProduct(A.id);
  assert.equal(updated.category_id, null);
  assert.equal(updated.price_cents, 5500);
});

test('create honours the active flag and seeds bundle components on first save', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  const hidden = app.catalog.createProduct({ sku: 'HIDDEN', name: 'Hidden', active: false });
  assert.equal(hidden.active, 0);

  // Components may be addressed by SKU as well as by id, and must survive
  // the initial create (not only a follow-up edit).
  const kit = app.catalog.createProduct({
    sku: 'KIT-1',
    name: 'Starter kit',
    bundleComponents: [{ componentProductId: A.sku, qtyRequired: 2 }],
  });
  assert.equal(kit.is_bundle, true);
  assert.equal(kit.bundle_components.length, 1);
  assert.equal(kit.bundle_components[0].component_product_id, A.id);
  assert.equal(kit.bundle_components[0].qty_required, 2);
});
