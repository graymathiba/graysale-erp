import { badRequest } from '../../lib/errors.js';

// Point of sale: checkout, refunds, layaways, quotes, the Flutter offline
// queue, the two-phase EcoCash flow (+ provider webhook), ZIMRA fiscal
// receipt lifecycle and order history.

export function registerPos({ route, services: S, requireCap, PUBLIC, NumID }) {
  const { pos, eco, fiscal } = S;

  route('POST', '/pos/sell', 'pos.sell', async (ctx) => {
    requireCap('pos.sell')(ctx);
    const b = await ctx.body();
    return ctx.json(pos.checkout({ ...b, user: ctx.user }));
  });
  route('POST', '/pos/refund', 'pos.refund', async (ctx) => {
    requireCap('pos.refund')(ctx);
    const b = await ctx.body();
    return ctx.json(pos.refund({ ...b, user: ctx.user }));
  });
  route('POST', '/pos/layaway', 'pos.layaway', async (ctx) => {
    requireCap('pos.layaway')(ctx);
    const b = await ctx.body();
    return ctx.json(pos.createLayaway({ ...b, user: ctx.user }));
  });
  route('POST', '/pos/layaway/:id/pay', 'pos.layaway', async (ctx) => {
    requireCap('pos.layaway')(ctx);
    const b = await ctx.body();
    return ctx.json(pos.addLayawayPayment(ctx.params.id, b.payments, ctx.user));
  });
  route('POST', '/pos/layaway/:id/finalize', 'pos.layaway', async (ctx) => {
    requireCap('pos.layaway')(ctx);
    const b = await ctx.body();
    return ctx.json(pos.finalizeLayaway(ctx.params.id, b.payments, ctx.user));
  });
  route('POST', '/pos/layaway/:id/cancel', 'pos.layaway', async (ctx) => {
    requireCap('pos.layaway')(ctx);
    return ctx.json(pos.cancelLayaway(ctx.params.id, ctx.user));
  });
  route('POST', '/pos/quote', 'pos.quote', async (ctx) => {
    requireCap('pos.quote')(ctx);
    const b = await ctx.body();
    return ctx.json(pos.createQuote({ ...b, user: ctx.user }));
  });
  route('POST', '/pos/quote/:id/convert', 'pos.quote', async (ctx) => {
    requireCap('pos.quote')(ctx);
    const b = await ctx.body();
    return ctx.json(pos.convertQuote(ctx.params.id, b.payments, ctx.user));
  });

  // ----- Offline queue sync (Flutter POS) -----
  // Replays sales captured while the till was offline. Idempotent on the
  // client-supplied `id`, and always 200: per-sale outcomes are reported in
  // the body so one bad sale cannot make the till retry the whole queue.
  route('POST', '/sync/sales', 'pos.sell', async (ctx) => {
    requireCap('pos.sell')(ctx);
    const b = await ctx.body();
    return ctx.json(pos.syncSales({ sales: b.sales, user: ctx.user }));
  });

  // ----- EcoCash C2B (two-phase: phone prompt -> webhook/poll settles the sale) -----
  route('POST', '/pos/ecocash/initiate', 'pos.sell', async (ctx) => {
    requireCap('pos.sell')(ctx);
    const b = await ctx.body();
    return ctx.json(await pos.ecocashInitiate({ ...b, user: ctx.user }), 201);
  });
  route('GET', '/pos/ecocash/status/:id', 'pos.sell', async (ctx) => {
    requireCap('pos.sell')(ctx);
    return ctx.json(await pos.ecocashStatus(NumID(ctx.params.id), ctx.user));
  });
  route('POST', '/pos/ecocash/cancel', 'pos.sell', async (ctx) => {
    requireCap('pos.sell')(ctx);
    const b = await ctx.body();
    return ctx.json(pos.ecocashCancel(NumID(b.orderId), ctx.user));
  });
  route('POST', '/pos/ecocash/refund', 'pos.refund', async (ctx) => {
    requireCap('pos.refund')(ctx);
    const b = await ctx.body();
    return ctx.json(await pos.ecocashRefund({ ...b, user: ctx.user }), 201);
  });
  // Provider callback — signature-verified, idempotent, settles the pending sale.
  route('POST', '/ecocash/webhook', PUBLIC, async (ctx) => {
    let raw = '';
    for await (const c of ctx.req) {
      raw += c;
      if (raw.length > 4e6) break;
    }
    let payload = {};
    try {
      payload = JSON.parse(raw);
    } catch {
      throw badRequest('BAD_JSON');
    }
    const signature = ctx.req.headers['x-ecocash-signature'] || ctx.req.headers['x-signature'] || '';
    const settled = await eco.callback({
      reference: payload.reference || payload.sourceReference,
      status: payload.status,
      amountCents:
        payload.amountCents ?? (payload.amount != null ? Math.round(Number(payload.amount) * 100) : undefined),
      phone: payload.sourceMobileNumber || payload.phone,
      providerRef: payload.transactionId,
      rawBody: raw,
      signature,
    });
    let order = null;
    if (
      settled.status === 'COMPLETED' ||
      settled.status === 'FAILED' ||
      settled.status === 'CANCELLED' ||
      settled.status === 'TIMED_OUT' ||
      settled.status === 'EXPIRED'
    ) {
      order = await pos.completeEcoCash(settled.reference);
    }
    return ctx.json({
      ok: true,
      txn: { id: settled.id, status: settled.status, reference: settled.reference },
      order: order ? { id: order.id, doc_no: order.doc_no, status: order.status } : null,
    });
  });

  // ----- ZIMRA FDMS fiscal receipts -----
  route('GET', '/pos/fiscal/status', 'settings.manage', async (ctx) => {
    requireCap('settings.manage')(ctx);
    return ctx.json(fiscal.status(ctx.user));
  });
  route('POST', '/pos/fiscal/register', 'settings.manage', async (ctx) => {
    requireCap('settings.manage')(ctx);
    return ctx.json(await fiscal.register({ user: ctx.user }));
  });
  route('POST', '/pos/fiscal/open-day', 'settings.manage', async (ctx) => {
    requireCap('settings.manage')(ctx);
    return ctx.json(await fiscal.openDay({ user: ctx.user }));
  });
  route('POST', '/pos/fiscal/close-day', 'settings.manage', async (ctx) => {
    requireCap('settings.manage')(ctx);
    return ctx.json(await fiscal.closeDay({ user: ctx.user }));
  });
  route('POST', '/pos/fiscal/submit-queue', 'settings.manage', async (ctx) => {
    requireCap('settings.manage')(ctx);
    return ctx.json(await fiscal.submitQueue({ user: ctx.user }));
  });
  route('GET', '/pos/fiscal/queue', 'settings.manage', async (ctx) => {
    requireCap('settings.manage')(ctx);
    return ctx.json(fiscal.queue({ tenantId: ctx.tenantId }));
  });

  route('GET', '/orders', null, (ctx) =>
    ctx.json(pos.orders({ type: ctx.query.type, status: ctx.query.status, tenantId: ctx.tenantId })),
  );
  route('GET', '/orders/:id', null, (ctx) => ctx.json(pos.getOrder(ctx.params.id, ctx.tenantId)));
}
