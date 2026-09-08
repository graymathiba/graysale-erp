import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, forbidden } from '../lib/errors.js';
import { formatCents } from '../lib/money.js';
import { LicensingService, makeEnforceTenantStatus } from '../../../src/licensing/index.js';

const STATIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
// New React (Vite) frontend — preferred over the legacy public/ app when built.
const WEB_DIST_DIR = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};

// ---------- request context ----------
function makeCtx(services, req, res, url) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = services.auth.userForToken(token);
  const nicer = (n) => typeof n === 'number' ? n : (Number(n) || 0);
  return {
    services, req, res, url, user, token,
    tenantId: (user && user.tenantId) || null,
    json(body, status = 200) {
      const pretty = typeof body === 'object' ? body : { ok: body };
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(pretty));
      return true;
    },
    async body() {
      let data = '';
      for await (const c of req) { data += c; if (data.length > 8e6) break; }
      return data ? JSON.parse(data) : {};
    },
  };
}

function attachHelpers(services) {
  services.formatCents = formatCents;
  services.nicer = (n) => Number(n) || 0;
  return services;
}

// ---------- route table ----------
export function buildHandler(services) {
  attachHelpers(services);
  const S = services;
  const {
    auth, catalog, customers, suppliers, accounting, invoicing,
    pos, payments, purchasing, banks, eod, reports,
  } = S;

  const R = [];

  const route = (method, path, caps, fn) => R.push({ method, path, caps, fn });

  const requireCap = (cap) => (ctx) => auth.require(ctx.user, cap);

  // Tenant owners may run the self-service profile endpoints; everyone else
  // (no session, cashier, manager...) is refused here and by the service layer.
  const ownerOnly = (ctx) => {
    if (!ctx.user || ctx.user.role !== 'owner') throw forbidden();
    return ctx.user;
  };

  // ----- licensing / Control Tower -----
  const licensing = new LicensingService(S.db);
  const superAdmin = (ctx) => auth.requireSuperAdmin(ctx.user);

  route('GET', '/superadmin/overview', null, async ctx => { superAdmin(ctx); return ctx.json(licensing.overview()); });

  route('GET', '/superadmin/tenants', null, async ctx => { superAdmin(ctx); return ctx.json(licensing.tenants.list({ search: ctx.query.search, status: ctx.query.status })); });
  route('POST', '/superadmin/tenants', null, async ctx => {
    superAdmin(ctx);
    const b = await ctx.body();
    const t = licensing.tenants.create({ companyName: b.companyName, ownerEmail: b.ownerEmail, status: b.status || 'PENDING_KEY', licenseKey: b.licenseKey, licenseExpiresAt: b.licenseExpiresAt });
    auth.audit(ctx.user.id, ctx.user.username, 'TENANT_CREATE', 'tenant', t.id, t.company_name);
    return ctx.json(t, 201);
  });
  route('GET', '/superadmin/tenants/:id', null, async ctx => { superAdmin(ctx); const t = licensing.tenants.get(ctx.params.id); if (!t) return ctx.json({ error: 'TENANT_NOT_FOUND' }, 404); return ctx.json(t); });
  route('POST', '/superadmin/tenants/:id/toggle', null, async ctx => {
    superAdmin(ctx);
    const t = licensing.tenants.toggleAccess(ctx.params.id);
    if (!t) return ctx.json({ error: 'TENANT_NOT_FOUND' }, 404);
    auth.audit(ctx.user.id, ctx.user.username, t.status === 'BLOCKED' ? 'TENANT_BLOCK' : 'TENANT_UNBLOCK', 'tenant', t.id, t.company_name);
    return ctx.json(t);
  });
  route('POST', '/superadmin/tenants/:id/extend', null, async ctx => {
    superAdmin(ctx);
    const b = await ctx.body();
    const days = Number(b.days);
    if (!Number.isInteger(days) || days <= 0) return ctx.json({ error: 'INVALID_DAYS' }, 400);
    const t = licensing.tenants.extend(ctx.params.id, days);
    if (!t) return ctx.json({ error: 'TENANT_NOT_FOUND' }, 404);
    auth.audit(ctx.user.id, ctx.user.username, 'TENANT_EXTEND', 'tenant', t.id, `${days} days`);
    return ctx.json(t);
  });
  route('PUT', '/superadmin/tenants/:id', null, async ctx => {
    superAdmin(ctx);
    const b = await ctx.body();
    const t = S.tenantProfile.adminUpdate(ctx.params.id, b, ctx.user);
    if (!t) return ctx.json({ error: 'TENANT_NOT_FOUND' }, 404);
    return ctx.json(t);
  });

  route('GET', '/superadmin/keys', null, async ctx => { superAdmin(ctx); return ctx.json(licensing.keys.list({ status: ctx.query.status, search: ctx.query.search })); });
  route('POST', '/superadmin/keys/generate', null, async ctx => {
    superAdmin(ctx);
    const b = await ctx.body();
    const r = licensing.keys.generate({ planType: b.planType, count: b.count || 1, generatedBy: ctx.user.id });
    auth.audit(ctx.user.id, ctx.user.username, 'KEY_GENERATE', 'product_key', null, `${r.count} x ${r.keys[0]?.planType}`);
    return ctx.json(r, 201);
  });
  route('POST', '/superadmin/keys/check', null, async ctx => {
    superAdmin(ctx);
    const b = await ctx.body();
    const k = licensing.keys.getByCode(b.keyCode);
    if (!k) return ctx.json({ error: 'INVALID_KEY' }, 404);
    return ctx.json(k);
  });
  route('POST', '/superadmin/keys/:id/revoke', null, async ctx => {
    superAdmin(ctx);
    const k = licensing.keys.revoke(ctx.params.id);
    if (!k) return ctx.json({ error: 'KEY_NOT_FOUND' }, 404);
    auth.audit(ctx.user.id, ctx.user.username, 'KEY_REVOKE', 'product_key', k.id, k.key_code);
    return ctx.json(k);
  });

  // Tenant-facing key redemption (bypasses the tenant gate so a lapsed or
  // pending-key instance can always reactivate itself).
  route('POST', '/license/activate', null, async ctx => {
    const b = await ctx.body();
    const keyCode = b.keyCode || b.key_code;
    if (!keyCode) return ctx.json({ error: 'MISSING_FIELD:keyCode' }, 400);
    const tenant = licensing.currentTenant();
    if (!tenant) return ctx.json({ error: 'NO_TENANT' }, 404);
    const result = licensing.keys.redeem(keyCode, tenant.id);
    if (!result.ok) return ctx.json(result, result.code === 'TENANT_NOT_FOUND' ? 404 : 400);
    auth.audit(ctx.user?.id, ctx.user?.username, 'LICENSE_ACTIVATE', 'tenant', tenant.id, keyCode);
    return ctx.json({ ok: true, tenant: result.tenant });
  });

  // Current tenant's license status — used by the /activate-license gate on
  // first login. Always readable (no auth gate): shows whether activation is
  // required and what the activity blocker returns before performing work.
  route('GET', '/license/status', null, ctx => {
    const tenant = licensing.currentTenant();
    if (!tenant) return ctx.json({ error: 'NO_TENANT' }, 404);
    const blocked = (tenant.status === 'PENDING_KEY' || tenant.status === 'PENDING_ACTIVATION' || tenant.status === 'BLOCKED');
    return ctx.json({
      status: tenant.status,
      activated: !blocked,
      activationRequired: blocked,
      companyName: tenant.company_name,
      licenseKey: tenant.license_key,
      expiresAt: tenant.license_expires_at,
    });
  });

  // ----- auth -----
  route('POST', '/auth/login', null, async ctx => {
    const b = await ctx.body();
    const r = auth.login(b);
    return ctx.json(r, r.ok ? 200 : 401);
  });
  route('POST', '/auth/logout', null, ctx => { auth.logout(ctx.token); return ctx.json({ ok: true }); });
  route('GET', '/auth/me', null, ctx => {
    if (!ctx.user) return ctx.json({ error: 'UNAUTHORIZED' }, 401);
    return ctx.json({ user: ctx.user, tenant: auth.tenantForUser(ctx.user) });
  });

  // ----- users & audit -----
  route('GET', '/users', 'users.view', ctx => ctx.json(auth.listUsers(ctx.tenantId)));
  route('POST', '/users', 'users.manage', async ctx => {
    requireCap('users.manage')(ctx);
    const b = await ctx.body();
    const id = auth.createUser({ ...b, fullName: b.fullName ?? b.full_name, tenantId: ctx.tenantId });
    auth.audit(ctx.user.id, ctx.user.username, 'USER_CREATE', 'user', id, b.username);
    return ctx.json({ id }, 201);
  });
  route('PUT', '/users/:id', 'users.manage', async ctx => {
    requireCap('users.manage')(ctx);
    const b = await ctx.body();
    auth.updateUser(ctx.params.id, b, ctx.tenantId);
    auth.audit(ctx.user.id, ctx.user.username, 'USER_UPDATE', 'user', ctx.params.id, JSON.stringify(b));
    return ctx.json({ ok: true });
  });
  route('DELETE', '/users/:id', 'users.delete', async ctx => {
    requireCap('users.delete')(ctx);
    const isPermanent = ctx.query.permanent === '1';
    const id = Number(ctx.params.id);
    let result;
    if (isPermanent) {
      result = auth.deleteUser(id, ctx.user, ctx.tenantId);
      auth.audit(ctx.user.id, ctx.user.username, 'USER_DELETE', 'user', id, 'permanent');
    } else {
      result = auth.deactivateUser(id, ctx.user, ctx.tenantId);
      auth.audit(ctx.user.id, ctx.user.username, 'USER_DEACTIVATE', 'user', id, '');
    }
    return ctx.json(result);
  });
  route('GET', '/audit', 'users.view', ctx => ctx.json(auth.listAudit(ctx.query.limit)));

  // ----- catalog -----
  route('GET', '/products', null, ctx => ctx.json(catalog.listProducts({ search: ctx.query.search, categoryId: ctx.query.categoryId, includeInactive: ctx.query.all === '1', tenantId: ctx.tenantId })));
  route('GET', '/products/low', null, ctx => ctx.json(catalog.lowStock(ctx.tenantId)));
  route('GET', '/products/search', null, ctx => ctx.json({ q: ctx.query.q, results: catalog.listProducts({ search: ctx.query.q, tenantId: ctx.tenantId }) }));
  route('GET', '/products/by-barcode/:barcode', null, ctx => {
    const p = catalog.findByBarcode(ctx.params.barcode, ctx.tenantId);
    return p ? ctx.json(p) : ctx.json({ error: 'NOT_FOUND' }, 404);
  });
  route('GET', '/products/:id', null, ctx => ctx.json(catalog.getProduct(ctx.params.id, ctx.tenantId)));
  route('POST', '/products', 'catalog.manage', async ctx => { requireCap('catalog.manage')(ctx); const b = await ctx.body(); const id = catalog.createProduct({ ...b, userId: ctx.user.id, username: ctx.user.username }, ctx.tenantId); return ctx.json({ id }, 201); });
  route('PUT', '/products/:id', 'catalog.manage', async ctx => { requireCap('catalog.manage')(ctx); const b = await ctx.body(); catalog.updateProduct(ctx.params.id, b, ctx.tenantId); auth.audit(ctx.user.id, ctx.user.username, 'PRODUCT_UPDATE', 'product', ctx.params.id, ''); return ctx.json({ ok: true }); });
  route('DELETE', '/products/:id', 'catalog.manage', async ctx => { requireCap('catalog.manage')(ctx); auth.audit(ctx.user.id, ctx.user.username, 'PRODUCT_DELETE', 'product', ctx.params.id, ''); return ctx.json(catalog.deleteProduct(ctx.params.id, ctx.tenantId)); });
  route('GET', '/categories', null, ctx => ctx.json(catalog.categories(ctx.tenantId)));
  route('POST', '/categories', 'catalog.manage', async ctx => { requireCap('catalog.manage')(ctx); const b = await ctx.body(); return ctx.json({ id: catalog.createCategory(b.name, ctx.tenantId) }, 201); });
  route('GET', '/tax-classes', null, ctx => ctx.json(catalog.taxClasses()));

  // ----- product extended attributes -----
  route('GET', '/products/:id/barcodes', null, ctx => ctx.json(catalog.barcodes(ctx.params.id)));
  route('POST', '/products/:id/barcodes', 'catalog.manage', async ctx => {
    requireCap('catalog.manage')(ctx);
    const b = await ctx.body();
    return ctx.json({ id: catalog.addBarcode(ctx.params.id, b.barcode, b.format, b.isPrimary) }, 201);
  });
  route('DELETE', '/products/:id/barcodes/:bid', 'catalog.manage', async ctx => {
    requireCap('catalog.manage')(ctx);
    catalog.removeBarcode(ctx.params.bid);
    return ctx.json({ ok: true });
  });

  route('GET', '/products/:id/price-tiers', null, ctx => ctx.json(catalog.priceTiers(ctx.params.id)));
  route('PUT', '/products/:id/price-tiers', 'catalog.manage', async ctx => {
    requireCap('catalog.manage')(ctx);
    const b = await ctx.body();
    return ctx.json(catalog.setPriceTiers(ctx.params.id, b.tiers || []));
  });

  route('GET', '/products/:id/batches', null, ctx => ctx.json(catalog.batches(ctx.params.id)));
  route('POST', '/products/:id/batches', 'inventory.adjust', async ctx => {
    requireCap('inventory.adjust')(ctx);
    const b = await ctx.body();
    const id = catalog.addBatch(ctx.params.id, b);
    // Adding a batch with a starting qty also increases on-hand stock
    if (b.qtyOnHand && Number(b.qtyOnHand) > 0) {
      catalog.move({ productId: ctx.params.id, qty: Math.round(Number(b.qtyOnHand)), type: 'RECEIPT', refType: 'batch', refId: id, note: `batch ${b.batchNo}`, userId: ctx.user.id });
    }
    auth.audit(ctx.user.id, ctx.user.username, 'BATCH_CREATE', 'product', ctx.params.id, b.batchNo);
    return ctx.json({ id }, 201);
  });
  route('POST', '/products/:id/batches/fefo', 'pos.sell', async ctx => {
    requireCap('pos.sell')(ctx);
    const b = await ctx.body();
    return ctx.json({ allocated: catalog.fefoAllocate(ctx.params.id, Math.round(Number(b.qty))) });
  });

  route('GET', '/products/:id/uom', null, ctx => ctx.json(catalog.uomList(ctx.params.id)));
  route('PUT', '/products/:id/uom', 'catalog.manage', async ctx => {
    requireCap('catalog.manage')(ctx);
    const b = await ctx.body();
    return ctx.json(catalog.setUom(ctx.params.id, b.uom || []));
  });

  route('GET', '/products/:id/bundle', null, ctx => ctx.json({ components: catalog.bundleComponents(ctx.params.id) }));
  route('PUT', '/products/:id/bundle', 'catalog.manage', async ctx => {
    requireCap('catalog.manage')(ctx);
    const b = await ctx.body();
    return ctx.json({ components: catalog.setBundle(ctx.params.id, b.components || []) });
  });

  // ----- inventory -----
  route('GET', '/inventory/stock', 'inventory.view', ctx => ctx.json(catalog.listProducts({ includeInactive: true, tenantId: ctx.tenantId })));
  route('GET', '/inventory/movements', 'inventory.view', ctx => ctx.json(catalog.movements({ productId: ctx.query.productId })));
  route('POST', '/inventory/adjust', 'inventory.adjust', async ctx => {
    requireCap('inventory.adjust')(ctx);
    const b = await ctx.body();
    const q = catalog.move({ productId: b.productId, qty: b.qty, type: b.type || 'ADJUST', note: b.note, userId: ctx.user.id, tenantId: ctx.tenantId });
    auth.audit(ctx.user.id, ctx.user.username, 'INVENTORY_ADJUST', 'product', b.productId, `${b.type}:${b.qty} ${b.note || ''}`);
    return ctx.json({ qtyOnHand: q });
  });

  // ----- parties -----
  route('GET', '/customers', null, ctx => ctx.json(customers.list({ search: ctx.query.search, tenantId: ctx.tenantId })));
  route('POST', '/customers', 'customers.manage', async ctx => { const b = await ctx.body(); return ctx.json({ id: customers.create(b, ctx.tenantId) }, 201); });
  route('GET', '/customers/:id', null, ctx => ctx.json(customers.get(ctx.params.id, ctx.tenantId)));
  route('PUT', '/customers/:id', 'customers.manage', async ctx => { const b = await ctx.body(); return ctx.json(customers.update(ctx.params.id, b, ctx.tenantId)); });
  route('DELETE', '/customers/:id', 'customers.manage', async ctx => { auth.audit(ctx.user.id, ctx.user.username, 'CUSTOMER_DELETE', 'customer', ctx.params.id, ''); return ctx.json(customers.delete(ctx.params.id, ctx.tenantId)); });
  route('GET', '/customers/:id/ledger', null, ctx => ctx.json(customers.ledger(ctx.params.id, 100, ctx.tenantId)));
  route('GET', '/customers/:id/layaways', null, ctx => ctx.json(customers.layaways(ctx.params.id, ctx.tenantId)));

  route('GET', '/suppliers', null, ctx => ctx.json(suppliers.list({ search: ctx.query.search, tenantId: ctx.tenantId })));
  route('POST', '/suppliers', 'suppliers.manage', async ctx => { const b = await ctx.body(); return ctx.json({ id: suppliers.create(b, ctx.tenantId) }, 201); });
  route('GET', '/suppliers/:id', null, ctx => ctx.json(suppliers.get(ctx.params.id, ctx.tenantId)));
  route('PUT', '/suppliers/:id', 'suppliers.manage', async ctx => { const b = await ctx.body(); return ctx.json(suppliers.update(ctx.params.id, b, ctx.tenantId)); });
  route('DELETE', '/suppliers/:id', 'suppliers.manage', async ctx => { auth.audit(ctx.user.id, ctx.user.username, 'SUPPLIER_DELETE', 'supplier', ctx.params.id, ''); return ctx.json(suppliers.delete(ctx.params.id, ctx.tenantId)); });
  route('GET', '/suppliers/:id/ledger', null, ctx => ctx.json(suppliers.ledger(ctx.params.id, ctx.tenantId)));

  // ----- POS -----
  route('POST', '/pos/sell', 'pos.sell', async ctx => { requireCap('pos.sell')(ctx); const b = await ctx.body(); return ctx.json(pos.checkout({ ...b, user: ctx.user })); });
  route('POST', '/pos/refund', 'pos.refund', async ctx => { requireCap('pos.refund')(ctx); const b = await ctx.body(); return ctx.json(pos.refund({ ...b, user: ctx.user })); });
  route('POST', '/pos/layaway', 'pos.layaway', async ctx => { requireCap('pos.layaway')(ctx); const b = await ctx.body(); return ctx.json(pos.createLayaway({ ...b, user: ctx.user })); });
  route('POST', '/pos/layaway/:id/pay', 'pos.layaway', async ctx => { requireCap('pos.layaway')(ctx); const b = await ctx.body(); return ctx.json(pos.addLayawayPayment(ctx.params.id, b.payments, ctx.user)); });
  route('POST', '/pos/layaway/:id/finalize', 'pos.layaway', async ctx => { requireCap('pos.layaway')(ctx); const b = await ctx.body(); return ctx.json(pos.finalizeLayaway(ctx.params.id, b.payments, ctx.user)); });
  route('POST', '/pos/layaway/:id/cancel', 'pos.layaway', async ctx => { requireCap('pos.layaway')(ctx); return ctx.json(pos.cancelLayaway(ctx.params.id, ctx.user)); });
  route('POST', '/pos/quote', 'pos.quote', async ctx => { requireCap('pos.quote')(ctx); const b = await ctx.body(); return ctx.json(pos.createQuote({ ...b, user: ctx.user })); });
  route('POST', '/pos/quote/:id/convert', 'pos.quote', async ctx => { requireCap('pos.quote')(ctx); const b = await ctx.body(); return ctx.json(pos.convertQuote(ctx.params.id, b.payments, ctx.user)); });

  route('GET', '/orders', null, ctx => ctx.json(pos.orders({ type: ctx.query.type, status: ctx.query.status, tenantId: ctx.tenantId })));
  route('GET', '/orders/:id', null, ctx => ctx.json(pos.getOrder(ctx.params.id, ctx.tenantId)));

  // ----- invoicing (AR/AP) -----
  route('GET', '/ar', 'invoicing.view', ctx => ctx.json(invoicing.listAr({ customerId: ctx.query.customerId, status: ctx.query.status, kind: ctx.query.kind, tenantId: ctx.tenantId })));
  route('POST', '/ar', 'invoicing.manage', async ctx => {
    const b = await ctx.body();
    const inv = invoicing.createArInvoice({
      customerId: b.customerId, subtotalCents: b.subtotalCents, discountCents: b.discountCents,
      taxCents: b.taxCents, dueDays: b.dueDays, note: b.note, tenantId: ctx.tenantId,
    });
    auth.audit(ctx.user.id, ctx.user.username, 'AR_CREATE', 'ar_invoice', inv.id, inv.doc_no);
    return ctx.json(inv, 201);
  });
  route('POST', '/ar/credit-note', 'invoicing.manage', async ctx => {
    const b = await ctx.body();
    const cn = invoicing.createCreditNote({ customerId: b.customerId, subtotalCents: b.subtotalCents, discountCents: b.discountCents, taxCents: b.taxCents, note: b.note, tenantId: ctx.tenantId });
    auth.audit(ctx.user.id, ctx.user.username, 'AR_CREDIT_NOTE', 'ar_invoice', cn.id, cn.doc_no);
    return ctx.json(cn, 201);
  });
  route('GET', '/ap', 'invoicing.view', ctx => ctx.json(invoicing.listAp({ supplierId: ctx.query.supplierId, status: ctx.query.status, tenantId: ctx.tenantId })));

  // ----- payments -----
  route('POST', '/payments/receive', 'invoicing.manage', async ctx => { const b = await ctx.body(); const p = payments.receivePayment({ ...b, user: ctx.user }); auth.audit(ctx.user.id, ctx.user.username, 'RECEIPT', 'payment', p.id, p.doc_no); return ctx.json(p, 201); });
  route('POST', '/payments/pay-supplier', 'purchasing.manage', async ctx => { const b = await ctx.body(); const p = payments.paySupplier({ ...b, user: ctx.user }); auth.audit(ctx.user.id, ctx.user.username, 'SUPPLIER_PAYMENT', 'payment', p.id, p.doc_no); return ctx.json(p, 201); });
  route('GET', '/payments', null, ctx => ctx.json(payments.listPayments({ kind: ctx.query.kind, partyType: ctx.query.partyType, partyId: ctx.query.partyId, tenantId: ctx.tenantId })));

  // ----- purchasing -----
  route('GET', '/purchase-orders', 'purchasing.view', ctx => ctx.json(purchasing.list({ status: ctx.query.status, supplierId: ctx.query.supplierId })));
  route('POST', '/purchase-orders', 'purchasing.manage', async ctx => { const b = await ctx.body(); const po = purchasing.createPo({ ...b, user: ctx.user }); auth.audit(ctx.user.id, ctx.user.username, 'PO_CREATE', 'purchase_order', po.id, po.doc_no); return ctx.json(po, 201); });
  route('GET', '/purchase-orders/:id', 'purchasing.view', ctx => ctx.json(purchasing.getPo(ctx.params.id)));
  route('POST', '/purchase-orders/:id/place', 'purchasing.manage', async ctx => { requireCap('purchasing.manage')(ctx); return ctx.json(purchasing.placePo(ctx.params.id)); });
  route('POST', '/purchase-orders/:id/receive', 'purchasing.manage', async ctx => { requireCap('purchasing.manage')(ctx); const b = await ctx.body(); const r = purchasing.receivePo({ poId: ctx.params.id, items: b.items, note: b.note, user: ctx.user }); auth.audit(ctx.user.id, ctx.user.username, 'PO_RECEIVE', 'purchase_order', ctx.params.id, r.grNo); return ctx.json(r, 201); });
  route('GET', '/goods-receipts', 'purchasing.view', ctx => ctx.json(purchasing.goodsReceipts({})));

  // ----- accounting -----
  route('GET', '/accounting/chart', 'accounting.view', ctx => ctx.json(accounting.chart()));
  route('GET', '/accounting/trial-balance', 'accounting.view', ctx => ctx.json(accounting.trialBalance()));
  route('GET', '/accounting/pl', 'accounting.view', ctx => ctx.json(accounting.profitAndLoss()));
  route('GET', '/accounting/balance-sheet', 'accounting.view', ctx => ctx.json(accounting.balanceSheet()));
  route('GET', '/accounting/verify', 'accounting.view', ctx => ctx.json(accounting.verify()));
  route('GET', '/accounting/entries', 'accounting.view', ctx => ctx.json(accounting.entries({ accountCode: ctx.query.account })));
  route('GET', '/accounting/entries/:id', 'accounting.view', ctx => ctx.json(accounting.entryLines(ctx.params.id)));
  route('POST', '/accounting/journal', 'accounting.post', async ctx => {
    requireCap('accounting.post')(ctx);
    const b = await ctx.body();
    const e = accounting.postEntry({ date: b.date, description: b.description, reference: b.reference, lines: b.lines, user: ctx.user });
    auth.audit(ctx.user.id, ctx.user.username, 'JOURNAL_POST', 'journal_entries', e.id, e.doc_no);
    return ctx.json(e, 201);
  });

  // ----- banks -----
  route('GET', '/banks', 'accounting.view', ctx => ctx.json(banks.accounts()));
  route('GET', '/banks/transactions', 'accounting.view', ctx => ctx.json(banks.transactions({ bankAccountId: ctx.query.bankAccountId, reconciled: ctx.query.reconciled })));
  route('POST', '/banks/transactions', 'accounting.reconcile', async ctx => { const b = await ctx.body(); return ctx.json({ id: banks.addManual({ ...b, user: ctx.user }) }, 201); });
  route('POST', '/banks/reconcile', 'accounting.reconcile', async ctx => { const b = await ctx.body(); const recId = banks.reconcile({ ...b }); auth.audit(ctx.user.id, ctx.user.username, 'BANK_RECONCILE', 'reconciliation', recId, ''); return ctx.json({ id: recId }, 201); });
  route('GET', '/banks/reconciliations', 'accounting.view', ctx => ctx.json(banks.reconciliations()));

  // ----- EOD -----
  route('POST', '/eod/open', 'eod.self', async ctx => { const b = await ctx.body(); return ctx.json(eod.open({ user: ctx.user, ...b }), 201); });
  route('POST', '/eod/close', 'eod.run', async ctx => { const b = await ctx.body(); const s = eod.close({ shiftId: b.shiftId, countedCashCents: b.countedCashCents, note: b.note, user: ctx.user }); auth.audit(ctx.user.id, ctx.user.username, 'EOD_CLOSE', 'shift', s.id, s.doc_no); return ctx.json(s); });
  route('GET', '/eod/shifts', 'eod.view', ctx => ctx.json(eod.list({ user: ctx.query.userId })));
  route('GET', '/eod/current', 'eod.self', ctx => ctx.json(eod.currentOpen(ctx.user.id)));
  // X-report: read-only per-shift report (does not close). Cashiers may only
  // read their own shift; admins may read any.
  route('GET', '/eod/report/:id', 'eod.self', async ctx => {
    const s = eod.get(Number(ctx.params.id));
    if (ctx.user.role !== 'owner' && ctx.user.role !== 'manager' && s.user_id !== ctx.user.id) {
      return ctx.json({ error: 'FORBIDDEN' }, 403);
    }
    return ctx.json(eod.report(Number(ctx.params.id)));
  });
  // Z-report: auto-closes the shift on generation. Cashiers close their own
  // shift; admins may close any shift.
  route('POST', '/eod/report/:id/z', 'eod.self', async ctx => {
    const b = await ctx.body();
    const s = eod.get(Number(ctx.params.id));
    if (ctx.user.role !== 'owner' && ctx.user.role !== 'manager' && s.user_id !== ctx.user.id) {
      return ctx.json({ error: 'FORBIDDEN' }, 403);
    }
    const rep = eod.zReport(Number(ctx.params.id), { countedCashCents: b.countedCashCents, note: b.note, user: ctx.user });
    auth.audit(ctx.user.id, ctx.user.username, 'EOD_ZREPORT', 'shift', Number(ctx.params.id), rep.shift.doc_no);
    return ctx.json(rep);
  });

  // ----- reports -----
  route('GET', '/reports/summary', null, ctx => ctx.json(reports.salesSummary({ from: ctx.query.from, to: ctx.query.to, tenantId: ctx.tenantId })));
  route('GET', '/reports/top-products', null, ctx => ctx.json(reports.topProducts(NumID(ctx.query.limit, 10), { from: ctx.query.from, to: ctx.query.to, tenantId: ctx.tenantId })));
  route('GET', '/reports/by-day', null, ctx => ctx.json(reports.salesByDay({ from: ctx.query.from, to: ctx.query.to, tenantId: ctx.tenantId })));
  route('GET', '/reports/by-category', null, ctx => ctx.json(reports.salesByCategory({ from: ctx.query.from, to: ctx.query.to, tenantId: ctx.tenantId })));
  route('GET', '/reports/cashiers', null, ctx => ctx.json(reports.cashierPerformance({ from: ctx.query.from, to: ctx.query.to, tenantId: ctx.tenantId })));
  route('GET', '/reports/dead-stock', null, ctx => ctx.json(reports.deadStock(NumID(ctx.query.days, 30), ctx.tenantId)));
  route('GET', '/dashboard', null, ctx => ctx.json({
    today: reports.salesSummary({ tenantId: ctx.tenantId }),
    byDay: reports.salesByDay({ from: new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10), tenantId: ctx.tenantId }),
    lowStock: catalog.lowStock(ctx.tenantId).slice(0, 8),
  }));

  // Real financial dashboard stats — tenant-scoped SQL aggregation.
  route('GET', '/dashboard/stats', null, async ctx => ctx.json(reports.dashboardStats({ from: ctx.query.from, to: ctx.query.to, tenantId: ctx.tenantId })));

  // ----- settings -----
  route('GET', '/settings', null, ctx => ctx.json({
    company: dbSetting(S, 'company.name'), address: dbSetting(S, 'company.address'),
    phone: dbSetting(S, 'company.phone'), tin: dbSetting(S, 'company.tin'),
    currency: dbSetting(S, 'company.currency'), taxName: dbSetting(S, 'tax.name'),
    termsDays: dbSetting(S, 'doc.default_terms_days'),
    fiscal: dbSetting(S, 'pos.fiscal') === '1', cashDrawer: dbSetting(S, 'pos.cash_drawer') === '1',
  }));
  route('POST', '/settings', 'settings.manage', async ctx => {
    requireCap('settings.manage')(ctx);
    const b = await ctx.body();
    const map = {
      company: 'company.name', address: 'company.address', phone: 'company.phone', tin: 'company.tin',
      currency: 'company.currency', taxName: 'tax.name', termsDays: 'doc.default_terms_days',
    };
    const upsert = S.db.prepare(`
      INSERT INTO settings (key, value, tenant_id) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    for (const [k, key] of Object.entries(map)) if (b[k] !== undefined) upsert.run(key, String(b[k]), ctx.tenantId);
    if (b.fiscal !== undefined) upsert.run('pos.fiscal', b.fiscal ? '1' : '0', ctx.tenantId);
    if (b.cashDrawer !== undefined) upsert.run('pos.cash_drawer', b.cashDrawer ? '1' : '0', ctx.tenantId);
    auth.audit(ctx.user.id, ctx.user.username, 'SETTINGS_UPDATE', null, null, JSON.stringify(b));
    return ctx.json({ ok: true });
  });

  // ----- company settings (dynamic invoice/quotation documents) -----
  route('GET', '/company-settings', null, ctx => ctx.json(S.companySettings.get(ctx.tenantId)));
  route('PUT', '/company-settings', 'settings.manage', async ctx => {
    requireCap('settings.manage')(ctx);
    const b = await ctx.body();
    const saved = S.companySettings.update(b, ctx.tenantId);
    auth.audit(ctx.user.id, ctx.user.username, 'SETTINGS_UPDATE', 'company_settings', 1, JSON.stringify(b));
    return ctx.json(saved);
  });

  // ----- tenant profile (owner self-service) -----
  route('GET', '/tenant/profile', null, async ctx => {
    ownerOnly(ctx);
    return ctx.json(S.tenantProfile.get(ctx.tenantId));
  });
  route('PUT', '/tenant/profile', null, async ctx => {
    ownerOnly(ctx);
    const b = await ctx.body();
    const saved = S.tenantProfile.update(b, ctx.tenantId, ctx.user);
    return ctx.json(saved);
  });

  // ----- printers -----
  route('GET', '/printers', null, ctx => ctx.json(
    S.db.prepare('SELECT * FROM printers ORDER BY is_default DESC, name').all()
  ));
  route('POST', '/printers', 'settings.manage', async ctx => {
    requireCap('settings.manage')(ctx);
    const b = await ctx.body();
    if (!b.name) return ctx.json({ error: 'PRINTER_NAME_REQUIRED' }, 400);
    const info = S.db.prepare(`
      INSERT INTO printers (name, type, connection, ip_address, cash_drawer, fiscal)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(b.name, b.type || '80mm', b.connection || 'USB', b.ipAddress || null, b.cashDrawer ? 1 : 0, b.fiscal ? 1 : 0);
    if (b.isDefault) setDefaultPrinter(S, info.lastInsertRowid);
    auth.audit(ctx.user.id, ctx.user.username, 'PRINTER_CREATE', 'printer', info.lastInsertRowid, b.name);
    return ctx.json({ id: info.lastInsertRowid }, 201);
  });
  route('PUT', '/printers/:id', 'settings.manage', async ctx => {
    requireCap('settings.manage')(ctx);
    const b = await ctx.body();
    const sets = [];
    const vals = [];
    const map = { name: 'name', type: 'type', connection: 'connection', ipAddress: 'ip_address', cashDrawer: 'cash_drawer', fiscal: 'fiscal', active: 'active' };
    for (const [key, col] of Object.entries(map)) if (b[key] !== undefined) { sets.push(`${col} = ?`); vals.push(col === 'cash_drawer' || col === 'fiscal' || col === 'active' ? (b[key] ? 1 : 0) : b[key]); }
    if (!sets.length) return ctx.json({ ok: true });
    if (b.isDefault) { setDefaultPrinter(S, ctx.params.id); }
    vals.push(Number(ctx.params.id));
    S.db.prepare(`UPDATE printers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    auth.audit(ctx.user.id, ctx.user.username, 'PRINTER_UPDATE', 'printer', Number(ctx.params.id), JSON.stringify(b));
    return ctx.json({ ok: true });
  });
  route('DELETE', '/printers/:id', 'settings.manage', async ctx => {
    requireCap('settings.manage')(ctx);
    S.db.prepare('DELETE FROM printers WHERE id = ?').run(Number(ctx.params.id));
    return ctx.json({ ok: true });
  });

  return R;
}

function setDefaultPrinter(services, id) {
  services.db.prepare('UPDATE printers SET is_default = 0').run();
  services.db.prepare('UPDATE printers SET is_default = 1 WHERE id = ?').run(Number(id));
}

function NumID(v, dflt) { const n = Number.parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : dflt; }

function dbSetting(services, key) {
  return services.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '';
}

// ---------- match a request ----------
export function matchRoute(routes, method, segments) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const parts = r.path.split('/').filter(Boolean);
    if (parts.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = segments[i];
      else if (parts[i] !== segments[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.fn, caps: r.caps, params };
  }
  return null;
}

// ---------- HTTP server ----------
export function createHttpServer(services) {
  const routes = buildHandler(services);
  const enforceTenantStatus = makeEnforceTenantStatus(services.db);
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const segments = url.pathname.split('/').filter(Boolean);
    const ctx = makeCtx(services, req, res, url);
    ctx.query = Object.fromEntries(url.searchParams);
    try {
      if (segments[0] === 'api' && segments[1] === 'v1') {
        const rest = segments.slice(2);
        // Licensing gate: superadmin + the whole /license scope (status check
        // and key activation) are never blocked so a lapsed or unactivated
        // instance can always see and fix its state.
        const isSuperAdminScope = rest[0] === 'superadmin';
        const isLicenseScope = rest[0] === 'license';
        if (!isSuperAdminScope && !isLicenseScope) {
          if (enforceTenantStatus(req, res, rest)) return;
        }
        const match = matchRoute(routes, req.method, rest);
        if (!match) return ctx.json({ error: 'NOT_FOUND' }, 404);
        if (match.caps) services.auth.require(ctx.user, match.caps);
        if (match.params) ctx.params = match.params;
        return await match.handler(ctx);
      }
      return serveStatic(req, res, url);
    } catch (e) {
      if (typeof e === 'object' && e && e.status) {
        // Clear, structured auth/error payloads: 401 / 403 carry a human
        // message plus a stable code the frontend can branch on.
        const body = { error: e.message, message: e.message, code: e.code || 'ERROR', status: e.status };
        return ctx.json(body, e.status);
      }
      if (e && e.message && e.message.includes('JSON')) return ctx.json({ error: 'BAD_JSON' }, 400);
      if (e && e.code === 'ERR_SQLITE_ERROR') {
        const msg = String(e.message || '');
        if (msg.includes('UNIQUE')) return ctx.json({ error: 'DUPLICATE: ' + msg }, 409);
        if (msg.includes('FOREIGN')) return ctx.json({ error: 'REFERENCE_ERROR: ' + msg }, 400);
        return ctx.json({ error: 'DB_ERROR: ' + msg }, 400);
      }
      console.error(e);
      return ctx.json({ error: e.message || 'INTERNAL' }, 500);
    }
  };
}

async function serveStatic(req, res, url) {
  let filePath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  let abs = join(WEB_DIST_DIR, filePath);
  if (!existsSync(abs)) {
    abs = join(STATIC_DIR, filePath);
  }
  if (!existsSync(abs)) {
    abs = join(WEB_DIST_DIR, 'index.html');
  }
  if (!existsSync(abs)) {
    abs = join(STATIC_DIR, 'index.html');
  }
  try {
    const data = readFileSync(abs);
    const ext = extname(abs);
    res.writeHead(200, { 'Content-Type': (MIME[ext] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  }
}