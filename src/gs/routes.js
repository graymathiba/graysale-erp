// Route table for the retail (graysale) HTTP API, ported onto the shared server.
// Only routes NOT already owned by the main ERP are matched here; main route
// handlers win first. Auth is delegated to the main AuthService via the shim.

function buildRoutes(services) {
  const { auth, catalog, customers, suppliers, accounting, invoicing, pos, payments, purchasing, banks, eod, reports } = services;
  const S = services;

  const R = [];
  const route = (method, path, caps, fn) => R.push({ method, path, caps, fn });
  const requireCap = (cap) => (ctx) => auth.require(ctx.user, cap);

  // ----- users (create only; list/update stay on the main handlers) -----
  route('POST', '/users', 'users.manage', async ctx => {
    requireCap('users.manage')(ctx);
    const b = await ctx.body();
    const id = auth.createUser({ ...b, fullName: b.fullName ?? b.full_name });
    auth.audit(ctx.user.id, ctx.user.username, 'USER_CREATE', 'user', id, b.username);
    return ctx.json({ id }, 201);
  });

  // ----- catalog -----
  route('GET', '/products', null, ctx => ctx.json(catalog.listProducts({ search: ctx.query.search, categoryId: ctx.query.categoryId, includeInactive: ctx.query.all === '1' })));
  route('GET', '/products/low', null, ctx => ctx.json(catalog.lowStock()));
  route('GET', '/products/search', null, ctx => ctx.json({ q: ctx.query.q, results: catalog.listProducts({ search: ctx.query.q }) }));
  route('GET', '/products/by-barcode/:barcode', null, ctx => {
    const p = catalog.findByBarcode(ctx.params.barcode);
    return p ? ctx.json(p) : ctx.json({ error: 'NOT_FOUND' }, 404);
  });
  route('GET', '/products/:id', null, ctx => ctx.json(catalog.getProduct(ctx.params.id)));
  route('POST', '/products', 'catalog.manage', async ctx => { requireCap('catalog.manage')(ctx); const b = await ctx.body(); const p = catalog.createProduct({ ...b, userId: ctx.user.id, username: ctx.user.username }); return ctx.json({ id: p.id }, 201); });
  route('PUT', '/products/:id', 'catalog.manage', async ctx => { requireCap('catalog.manage')(ctx); const b = await ctx.body(); catalog.updateProduct(ctx.params.id, b); auth.audit(ctx.user.id, ctx.user.username, 'PRODUCT_UPDATE', 'product', ctx.params.id, ''); return ctx.json({ ok: true }); });
  route('GET', '/categories', null, ctx => ctx.json(catalog.categories()));
  route('POST', '/categories', 'catalog.manage', async ctx => { requireCap('catalog.manage')(ctx); const b = await ctx.body(); return ctx.json({ id: catalog.createCategory(b.name).id }, 201); });
  route('GET', '/tax-classes', null, ctx => ctx.json(catalog.taxClasses()));

  // ----- inventory -----
  route('GET', '/inventory/stock', 'inventory.view', ctx => ctx.json(catalog.listProducts({ includeInactive: true })));
  route('GET', '/inventory/movements', 'inventory.view', ctx => ctx.json(catalog.movements({ productId: ctx.query.productId })));
  route('POST', '/inventory/adjust', 'inventory.adjust', async ctx => {
    requireCap('inventory.adjust')(ctx);
    const b = await ctx.body();
    const q = catalog.move({ productId: b.productId, qty: b.qty, type: b.type || 'ADJUST', note: b.note, userId: ctx.user.id });
    auth.audit(ctx.user.id, ctx.user.username, 'INVENTORY_ADJUST', 'product', b.productId, `${b.type}:${b.qty} ${b.note || ''}`);
    return ctx.json({ qtyOnHand: q });
  });

  // ----- parties -----
  route('GET', '/customers', null, ctx => ctx.json(customers.list({ search: ctx.query.search })));
  route('POST', '/customers', 'customers.manage', async ctx => { const b = await ctx.body(); return ctx.json({ id: customers.create(b).id }, 201); });
  route('GET', '/customers/:id', null, ctx => ctx.json(customers.get(ctx.params.id)));
  route('PUT', '/customers/:id', 'customers.manage', async ctx => { const b = await ctx.body(); return ctx.json(customers.update(ctx.params.id, b)); });
  route('GET', '/customers/:id/ledger', null, ctx => ctx.json(customers.ledger(ctx.params.id)));

  route('GET', '/suppliers', null, ctx => ctx.json(suppliers.list({ search: ctx.query.search })));
  route('POST', '/suppliers', 'suppliers.manage', async ctx => { const b = await ctx.body(); return ctx.json({ id: suppliers.create(b).id }, 201); });
  route('GET', '/suppliers/:id', null, ctx => ctx.json(suppliers.get(ctx.params.id)));
  route('GET', '/suppliers/:id/ledger', null, ctx => ctx.json(suppliers.ledger(ctx.params.id)));

  // ----- POS -----
  route('POST', '/pos/sell', 'pos.sell', async ctx => { requireCap('pos.sell')(ctx); const b = await ctx.body(); return ctx.json(pos.checkout({ ...b, user: ctx.user })); });
  route('POST', '/pos/refund', 'pos.refund', async ctx => { requireCap('pos.refund')(ctx); const b = await ctx.body(); return ctx.json(pos.refund({ ...b, user: ctx.user })); });
  route('POST', '/pos/layaway', 'pos.layaway', async ctx => { requireCap('pos.layaway')(ctx); const b = await ctx.body(); return ctx.json(pos.createLayaway({ ...b, user: ctx.user })); });
  route('POST', '/pos/layaway/:id/pay', 'pos.layaway', async ctx => { requireCap('pos.layaway')(ctx); const b = await ctx.body(); return ctx.json(pos.addLayawayPayment(ctx.params.id, b.payments, ctx.user)); });
  route('POST', '/pos/layaway/:id/finalize', 'pos.layaway', async ctx => { requireCap('pos.layaway')(ctx); const b = await ctx.body(); return ctx.json(pos.finalizeLayaway(ctx.params.id, b.payments, ctx.user)); });
  route('POST', '/pos/layaway/:id/cancel', 'pos.layaway', async ctx => { requireCap('pos.layaway')(ctx); return ctx.json(pos.cancelLayaway(ctx.params.id, ctx.user)); });
  route('POST', '/pos/quote', 'pos.quote', async ctx => { requireCap('pos.quote')(ctx); const b = await ctx.body(); return ctx.json(pos.createQuote({ ...b, user: ctx.user })); });
  route('POST', '/pos/quote/:id/convert', 'pos.quote', async ctx => { requireCap('pos.quote')(ctx); const b = await ctx.body(); return ctx.json(pos.convertQuote(ctx.params.id, b.payments, ctx.user)); });

  route('GET', '/orders', null, ctx => ctx.json(pos.orders({ type: ctx.query.type, status: ctx.query.status })));
  route('GET', '/orders/:id', null, ctx => ctx.json(pos.getOrder(ctx.params.id)));

  // ----- invoicing (AR/AP) -----
  route('GET', '/ar', 'invoicing.view', ctx => ctx.json(invoicing.listAr({ customerId: ctx.query.customerId, status: ctx.query.status, kind: ctx.query.kind })));
  route('POST', '/ar', 'invoicing.manage', async ctx => {
    const b = await ctx.body();
    const inv = invoicing.createArInvoice({
      customerId: b.customerId, subtotalCents: b.subtotalCents, discountCents: b.discountCents,
      taxCents: b.taxCents, dueDays: b.dueDays, note: b.note,
    });
    auth.audit(ctx.user.id, ctx.user.username, 'AR_CREATE', 'ar_invoice', inv.id, inv.doc_no);
    return ctx.json(inv, 201);
  });
  route('POST', '/ar/credit-note', 'invoicing.manage', async ctx => {
    const b = await ctx.body();
    const cn = invoicing.createCreditNote({ customerId: b.customerId, subtotalCents: b.subtotalCents, discountCents: b.discountCents, taxCents: b.taxCents, note: b.note });
    auth.audit(ctx.user.id, ctx.user.username, 'AR_CREDIT_NOTE', 'ar_invoice', cn.id, cn.doc_no);
    return ctx.json(cn, 201);
  });
  route('GET', '/ap', 'invoicing.view', ctx => ctx.json(invoicing.listAp({ supplierId: ctx.query.supplierId, status: ctx.query.status })));

  // ----- payments -----
  route('POST', '/payments/receive', 'invoicing.manage', async ctx => { const b = await ctx.body(); const p = payments.receivePayment({ ...b, user: ctx.user }); auth.audit(ctx.user.id, ctx.user.username, 'RECEIPT', 'payment', p.id, p.doc_no); return ctx.json(p, 201); });
  route('POST', '/payments/pay-supplier', 'purchasing.manage', async ctx => { const b = await ctx.body(); const p = payments.paySupplier({ ...b, user: ctx.user }); auth.audit(ctx.user.id, ctx.user.username, 'SUPPLIER_PAYMENT', 'payment', p.id, p.doc_no); return ctx.json(p, 201); });
  route('GET', '/payments', null, ctx => ctx.json(payments.listPayments({ kind: ctx.query.kind, partyType: ctx.query.partyType, partyId: ctx.query.partyId })));

  // ----- purchasing (main only owns partial-receive + cancel) -----
  route('GET', '/purchase-orders', 'purchasing.view', ctx => ctx.json(purchasing.list({ status: ctx.query.status, supplierId: ctx.query.supplierId })));
  route('POST', '/purchase-orders', 'purchasing.manage', async ctx => { const b = await ctx.body(); const po = purchasing.createPo({ ...b, user: ctx.user }); auth.audit(ctx.user.id, ctx.user.username, 'PO_CREATE', 'purchase_order', po.id, po.po_no); return ctx.json(po, 201); });
  route('GET', '/purchase-orders/:id', 'purchasing.view', ctx => ctx.json(purchasing.getPo(ctx.params.id)));
  route('POST', '/purchase-orders/:id/place', 'purchasing.manage', async ctx => { requireCap('purchasing.manage')(ctx); return ctx.json(purchasing.placePo(ctx.params.id)); });
  route('POST', '/purchase-orders/:id/receive', 'purchasing.manage', async ctx => { requireCap('purchasing.manage')(ctx); const b = await ctx.body(); const r = purchasing.receivePo({ poId: ctx.params.id, items: b.items, note: b.note, user: ctx.user }); auth.audit(ctx.user.id, ctx.user.username, 'PO_RECEIVE', 'purchase_order', ctx.params.id, r.grNo); return ctx.json(r, 201); });
  route('GET', '/goods-receipts', 'purchasing.view', ctx => ctx.json(purchasing.goodsReceipts({})));

  // ----- accounting (chart/trial/pl/bs/verify stay on the main handlers) -----
  route('GET', '/accounting/entries', 'accounting.view', ctx => ctx.json(accounting.entries({ accountCode: ctx.query.account, limit: 200 })));
  route('GET', '/accounting/entries/:id', 'accounting.view', ctx => ctx.json(accounting.entryLines(ctx.params.id)));
  route('POST', '/accounting/journal', 'accounting.post', async ctx => {
    requireCap('accounting.post')(ctx);
    const b = await ctx.body();
    const e = accounting.postEntry({ date: b.date, description: b.description, reference: b.reference, lines: b.lines, user: ctx.user });
    auth.audit(ctx.user.id, ctx.user.username, 'JOURNAL_POST', 'journal_entries', e.id, e.entry_no);
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

  // ----- reports (main owns top-products/by-category shared shapes; retail-only ones here) -----
  route('GET', '/reports/summary', null, ctx => ctx.json(reports.salesSummary({ from: ctx.query.from, to: ctx.query.to })));
  route('GET', '/reports/top-products', null, ctx => ctx.json(reports.topProducts(NumID(ctx.query.limit, 10), { from: ctx.query.from, to: ctx.query.to })));
  route('GET', '/reports/by-day', null, ctx => ctx.json(reports.salesByDay({ from: ctx.query.from, to: ctx.query.to })));
  route('GET', '/reports/by-category', null, ctx => ctx.json(reports.salesByCategory({ from: ctx.query.from, to: ctx.query.to })));
  route('GET', '/reports/cashiers', null, ctx => ctx.json(reports.cashierPerformance({ from: ctx.query.from, to: ctx.query.to })));
  route('GET', '/reports/dead-stock', null, ctx => ctx.json(reports.deadStock(NumID(ctx.query.days, 30))));
  route('GET', '/dashboard', null, ctx => ctx.json({
    today: reports.salesSummary(),
    byDay: reports.salesByDay({ from: new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) }),
    lowStock: catalog.lowStock().slice(0, 8),
  }));

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
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    for (const [k, key] of Object.entries(map)) if (b[k] !== undefined) upsert.run(key, String(b[k]));
    if (b.fiscal !== undefined) upsert.run('pos.fiscal', b.fiscal ? '1' : '0');
    if (b.cashDrawer !== undefined) upsert.run('pos.cash_drawer', b.cashDrawer ? '1' : '0');
    auth.audit(ctx.user.id, ctx.user.username, 'SETTINGS_UPDATE', null, null, JSON.stringify(b));
    return ctx.json({ ok: true });
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

// Match a request path (already split after /api/v1/) against the route table.
function matchGsRoute(routes, method, segments) {
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

export { buildRoutes, matchGsRoute };