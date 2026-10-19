import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, seedCatalog, customer, admin } from './helpers.js';
import { LicensingService, makeEnforceTenantStatus } from '../src/licensing/index.js';

test('new tenants default to PENDING_ACTIVATION until a key is redeemed', () => {
  const app = makeApp();
  const licensing = new LicensingService(app.db);
  const t = licensing.tenants.create({ companyName: 'Fresh Co', ownerEmail: 'fresh@ex.com' });
  assert.equal(t.status, 'PENDING_ACTIVATION');
  const pending = licensing.tenants.list({ status: 'PENDING_ACTIVATION' });
  assert.ok(
    pending.some((x) => x.id === t.id),
    'created tenant is listed as pending activation',
  );
});

test('PENDING_ACTIVATION tenants are blocked from ERP routes by the license gate', () => {
  const app = makeApp();
  const db = app.db;
  const licensing = new LicensingService(db);
  const tenant = licensing.currentTenant();
  licensing.tenants.setStatus(tenant.id, 'PENDING_ACTIVATION');

  let status = 0;
  let body = null;
  const res = {
    headersSent: false,
    writeHead(s) {
      status = s;
    },
    end(b) {
      body = b ? JSON.parse(b) : null;
    },
  };
  const gate = makeEnforceTenantStatus(db);

  // Normal ERP data routes are short-circuited with 402 ACTIVATION_REQUIRED.
  assert.equal(gate({}, res, ['products']), true);
  assert.equal(status, 402);
  assert.equal(body.error, 'ACTIVATION_REQUIRED');
  status = 0;
  body = null;
  assert.equal(gate({}, res, ['dashboard', 'stats']), true);
  assert.equal(status, 402);

  // /license/status + /license/activate and auth are never blocked.
  assert.equal(gate({}, res, ['license', 'status']), false);
  assert.equal(gate({}, res, ['license', 'activate']), false);
  assert.equal(gate({}, res, ['auth', 'login']), false);
  // An unactivated tenant must still be able to register and self-serve their
  // password before the license gate opens.
  assert.equal(gate({}, res, ['auth', 'register-tenant']), false);
  assert.equal(gate({}, res, ['auth', 'set-password']), false);

  // Redeeming a product key flips the tenant to ACTIVE and unblocks.
  const { keys } = licensing.keys.generate({ planType: 'MONTHLY', count: 1 });
  const r = licensing.keys.redeem(keys[0].keyCode, tenant.id);
  assert.equal(r.ok, true);
  assert.equal(r.tenant.status, 'ACTIVE');
  status = 0;
  assert.equal(gate({}, res, ['products']), false);
  assert.equal(status, 0);
});

test('strict tenant isolation: products, customers and users never leak across tenants', () => {
  const app = makeApp();
  const tenantA = app.db.prepare('SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1').get().id;
  const licensing = new LicensingService(app.db);
  const tenantB = licensing.tenants.create({ companyName: 'Tenant B', ownerEmail: 'b@ex.com' }).id;
  const TX = app.catalog.taxClasses().find((t) => t.name === 'Standard');

  // Products
  const catA = app.catalog.createCategory('Cat A', tenantA);
  const catB = app.catalog.createCategory('Cat B', tenantB);
  app.catalog.createProduct(
    { sku: 'T-A1', name: 'Prod A', categoryId: catA, costCents: 100, priceCents: 200, taxClassId: TX.id },
    tenantA,
  );
  const pB = app.catalog.createProduct(
    { sku: 'T-B1', name: 'Prod B', categoryId: catB, costCents: 100, priceCents: 200, taxClassId: TX.id },
    tenantB,
  );

  const listA = app.catalog.listProducts({ tenantId: tenantA });
  assert.equal(listA.length, 1);
  assert.equal(listA[0].sku, 'T-A1');
  assert.throws(
    () => app.catalog.getProduct(pB.id, tenantA),
    /PRODUCT_NOT_FOUND/,
    'tenant A must not read tenant B product',
  );
  assert.throws(() => app.catalog.resolveProduct(pB.id, tenantA), /PRODUCT_NOT_FOUND/, 'resolve stays in scope');
  assert.equal(app.catalog.findByBarcode('6000000000001', tenantA), null);

  // Customers
  const cA = app.customers.create({ name: 'Client A', phone: '1' }, tenantA);
  app.customers.create({ name: 'Client B', phone: '2' }, tenantB);
  assert.equal(app.customers.list({ tenantId: tenantA }).length, 1);
  assert.equal(app.customers.list({ tenantId: tenantA })[0].name, 'Client A');
  assert.throws(() => app.customers.get(cA, tenantB), /CUSTOMER_NOT_FOUND/, 'tenant B must not read tenant A customer');

  // Users
  app.auth.createUser({ username: 'a1', password: 'pw', role: 'cashier', tenantId: tenantA });
  app.auth.createUser({ username: 'b1', password: 'pw', role: 'cashier', tenantId: tenantB });
  const usersA = app.auth.listUsers(tenantA).map((u) => u.username);
  assert.ok(usersA.includes('a1'));
  assert.ok(!usersA.includes('b1'), 'users are scoped to their tenant');
});

test('dashboardStats aggregates real financial data (revenue, cash, ecocash, balance due)', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  const user = admin(app);
  const T = user.tenantId;

  // It starts clean for this tenant.
  const before = app.reports.dashboardStats({ tenantId: T });
  assert.equal(before.totalSalesCount, 0);

  // One sale split CASH + ECOCASH (Product A: 4500 + 15% = 5175).
  app.pos.checkout({
    items: [{ productId: A.id, qty: 1 }],
    payments: [
      { method: 'CASH', amount: 3000 },
      { method: 'ECOCASH', amount: 2175 },
    ],
    user,
  });
  // One unallocated credit invoice = money still owed to the business.
  const cid = customer(app, 'Debtor Co');
  app.invoicing.createArInvoice({ customerId: cid, subtotalCents: 10000, tenantId: T });

  const stats = app.reports.dashboardStats({ tenantId: T });
  assert.equal(stats.totalSalesCount, 1);
  assert.equal(stats.totalRevenue, 5175);
  assert.equal(stats.cashTotal, 3000);
  assert.equal(stats.ecoCashTotal, 2175, 'ECOCASH rolls up as mobile money');
  assert.equal(stats.mobileTotal, 0);
  assert.equal(stats.totalBalanceDue, 10000);

  // Nothing belongs to a different tenant.
  const licensing = new LicensingService(app.db);
  const other = licensing.tenants.create({ companyName: 'Other', ownerEmail: 'o@ex.com' });
  const otherStats = app.reports.dashboardStats({ tenantId: other.id });
  assert.equal(otherStats.totalSalesCount, 0);
  assert.equal(otherStats.totalRevenue, 0);
  assert.equal(otherStats.totalBalanceDue, 0);
});
