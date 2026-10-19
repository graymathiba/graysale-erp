// AR/AP invoicing and the payment journal (customer receipts + supplier
// payments).

export function registerInvoicing({ route, services: S }) {
  const { invoicing, payments, auth } = S;

  route('GET', '/ar', 'invoicing.view', (ctx) =>
    ctx.json(
      invoicing.listAr({
        customerId: ctx.query.customerId,
        status: ctx.query.status,
        kind: ctx.query.kind,
        tenantId: ctx.tenantId,
      }),
    ),
  );
  route('POST', '/ar', 'invoicing.manage', async (ctx) => {
    const b = await ctx.body();
    const inv = invoicing.createArInvoice({
      customerId: b.customerId,
      subtotalCents: b.subtotalCents,
      discountCents: b.discountCents,
      taxCents: b.taxCents,
      dueDays: b.dueDays,
      note: b.note,
      tenantId: ctx.tenantId,
    });
    auth.audit(ctx.user.id, ctx.user.username, 'AR_CREATE', 'ar_invoice', inv.id, inv.doc_no);
    return ctx.json(inv, 201);
  });
  route('POST', '/ar/credit-note', 'invoicing.manage', async (ctx) => {
    const b = await ctx.body();
    const cn = invoicing.createCreditNote({
      customerId: b.customerId,
      subtotalCents: b.subtotalCents,
      discountCents: b.discountCents,
      taxCents: b.taxCents,
      note: b.note,
      tenantId: ctx.tenantId,
    });
    auth.audit(ctx.user.id, ctx.user.username, 'AR_CREDIT_NOTE', 'ar_invoice', cn.id, cn.doc_no);
    return ctx.json(cn, 201);
  });
  route('GET', '/ap', 'invoicing.view', (ctx) =>
    ctx.json(invoicing.listAp({ supplierId: ctx.query.supplierId, status: ctx.query.status, tenantId: ctx.tenantId })),
  );

  route('POST', '/payments/receive', 'invoicing.manage', async (ctx) => {
    const b = await ctx.body();
    const p = payments.receivePayment({ ...b, user: ctx.user });
    auth.audit(ctx.user.id, ctx.user.username, 'RECEIPT', 'payment', p.id, p.doc_no);
    return ctx.json(p, 201);
  });
  route('POST', '/payments/pay-supplier', 'purchasing.manage', async (ctx) => {
    const b = await ctx.body();
    const p = payments.paySupplier({ ...b, user: ctx.user });
    auth.audit(ctx.user.id, ctx.user.username, 'SUPPLIER_PAYMENT', 'payment', p.id, p.doc_no);
    return ctx.json(p, 201);
  });
  route('GET', '/payments', null, (ctx) =>
    ctx.json(
      payments.listPayments({
        kind: ctx.query.kind,
        partyType: ctx.query.partyType,
        partyId: ctx.query.partyId,
        tenantId: ctx.tenantId,
      }),
    ),
  );
}
