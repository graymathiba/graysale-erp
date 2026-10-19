// Customers and suppliers, including their ledgers and layaways.

export function registerParties({ route, services: S }) {
  const { customers, suppliers, auth } = S;

  route('GET', '/customers', null, (ctx) =>
    ctx.json(customers.list({ search: ctx.query.search, tenantId: ctx.tenantId })),
  );
  route('POST', '/customers', 'customers.manage', async (ctx) => {
    const b = await ctx.body();
    return ctx.json({ id: customers.create(b, ctx.tenantId) }, 201);
  });
  route('GET', '/customers/:id', null, (ctx) => ctx.json(customers.get(ctx.params.id, ctx.tenantId)));
  route('PUT', '/customers/:id', 'customers.manage', async (ctx) => {
    const b = await ctx.body();
    return ctx.json(customers.update(ctx.params.id, b, ctx.tenantId));
  });
  route('DELETE', '/customers/:id', 'customers.manage', async (ctx) => {
    auth.audit(ctx.user.id, ctx.user.username, 'CUSTOMER_DELETE', 'customer', ctx.params.id, '');
    return ctx.json(customers.delete(ctx.params.id, ctx.tenantId));
  });
  route('GET', '/customers/:id/ledger', null, (ctx) => ctx.json(customers.ledger(ctx.params.id, 100, ctx.tenantId)));
  route('GET', '/customers/:id/layaways', null, (ctx) => ctx.json(customers.layaways(ctx.params.id, ctx.tenantId)));

  route('GET', '/suppliers', null, (ctx) =>
    ctx.json(suppliers.list({ search: ctx.query.search, tenantId: ctx.tenantId })),
  );
  route('POST', '/suppliers', 'suppliers.manage', async (ctx) => {
    const b = await ctx.body();
    return ctx.json({ id: suppliers.create(b, ctx.tenantId) }, 201);
  });
  route('GET', '/suppliers/:id', null, (ctx) => ctx.json(suppliers.get(ctx.params.id, ctx.tenantId)));
  route('PUT', '/suppliers/:id', 'suppliers.manage', async (ctx) => {
    const b = await ctx.body();
    return ctx.json(suppliers.update(ctx.params.id, b, ctx.tenantId));
  });
  route('DELETE', '/suppliers/:id', 'suppliers.manage', async (ctx) => {
    auth.audit(ctx.user.id, ctx.user.username, 'SUPPLIER_DELETE', 'supplier', ctx.params.id, '');
    return ctx.json(suppliers.delete(ctx.params.id, ctx.tenantId));
  });
  route('GET', '/suppliers/:id/ledger', null, (ctx) => ctx.json(suppliers.ledger(ctx.params.id, ctx.tenantId)));
}
