// Procurement: purchase orders and goods receipts.

export function registerPurchasing({ route, services: S, requireCap }) {
  const { purchasing, auth } = S;

  route('GET', '/purchase-orders', 'purchasing.view', (ctx) =>
    ctx.json(purchasing.list({ status: ctx.query.status, supplierId: ctx.query.supplierId })),
  );
  route('POST', '/purchase-orders', 'purchasing.manage', async (ctx) => {
    const b = await ctx.body();
    const po = purchasing.createPo({ ...b, user: ctx.user });
    auth.audit(ctx.user.id, ctx.user.username, 'PO_CREATE', 'purchase_order', po.id, po.doc_no);
    return ctx.json(po, 201);
  });
  route('GET', '/purchase-orders/:id', 'purchasing.view', (ctx) => ctx.json(purchasing.getPo(ctx.params.id)));
  route('POST', '/purchase-orders/:id/place', 'purchasing.manage', async (ctx) => {
    requireCap('purchasing.manage')(ctx);
    return ctx.json(purchasing.placePo(ctx.params.id));
  });
  route('POST', '/purchase-orders/:id/receive', 'purchasing.manage', async (ctx) => {
    requireCap('purchasing.manage')(ctx);
    const b = await ctx.body();
    const r = purchasing.receivePo({ poId: ctx.params.id, items: b.items, note: b.note, user: ctx.user });
    auth.audit(ctx.user.id, ctx.user.username, 'PO_RECEIVE', 'purchase_order', ctx.params.id, r.grNo);
    return ctx.json(r, 201);
  });
  route('GET', '/goods-receipts', 'purchasing.view', (ctx) => ctx.json(purchasing.goodsReceipts({})));
}
