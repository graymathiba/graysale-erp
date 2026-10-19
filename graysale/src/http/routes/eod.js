// Shift lifecycle: open/close, X-report (read-only) and Z-report (closes).

export function registerEod({ route, services: S }) {
  const { eod, auth } = S;

  route('POST', '/eod/open', 'eod.self', async (ctx) => {
    const b = await ctx.body();
    return ctx.json(eod.open({ user: ctx.user, ...b }), 201);
  });
  route('POST', '/eod/close', 'eod.run', async (ctx) => {
    const b = await ctx.body();
    const s = eod.close({ shiftId: b.shiftId, countedCashCents: b.countedCashCents, note: b.note, user: ctx.user });
    auth.audit(ctx.user.id, ctx.user.username, 'EOD_CLOSE', 'shift', s.id, s.doc_no);
    return ctx.json(s);
  });
  route('GET', '/eod/shifts', 'eod.view', (ctx) => ctx.json(eod.list({ user: ctx.query.userId })));
  route('GET', '/eod/current', 'eod.self', (ctx) => ctx.json(eod.currentOpen(ctx.user.id)));
  // X-report: read-only per-shift report (does not close). Cashiers may only
  // read their own shift; admins may read any.
  route('GET', '/eod/report/:id', 'eod.self', async (ctx) => {
    const s = eod.get(Number(ctx.params.id));
    if (ctx.user.role !== 'owner' && ctx.user.role !== 'manager' && s.user_id !== ctx.user.id) {
      return ctx.json({ error: 'FORBIDDEN' }, 403);
    }
    return ctx.json(eod.report(Number(ctx.params.id)));
  });
  // Z-report: auto-closes the shift on generation. Cashiers close their own
  // shift; admins may close any shift.
  route('POST', '/eod/report/:id/z', 'eod.self', async (ctx) => {
    const b = await ctx.body();
    const s = eod.get(Number(ctx.params.id));
    if (ctx.user.role !== 'owner' && ctx.user.role !== 'manager' && s.user_id !== ctx.user.id) {
      return ctx.json({ error: 'FORBIDDEN' }, 403);
    }
    const rep = eod.zReport(Number(ctx.params.id), {
      countedCashCents: b.countedCashCents,
      note: b.note,
      user: ctx.user,
    });
    auth.audit(ctx.user.id, ctx.user.username, 'EOD_ZREPORT', 'shift', Number(ctx.params.id), rep.shift.doc_no);
    return ctx.json(rep);
  });
}
