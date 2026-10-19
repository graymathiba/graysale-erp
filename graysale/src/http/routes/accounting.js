// General ledger, statements and bank accounts / reconciliation.

export function registerAccounting({ route, services: S, requireCap }) {
  const { accounting, banks, auth } = S;

  route('GET', '/accounting/chart', 'accounting.view', (ctx) => ctx.json(accounting.chart()));
  route('GET', '/accounting/trial-balance', 'accounting.view', (ctx) => ctx.json(accounting.trialBalance()));
  route('GET', '/accounting/pl', 'accounting.view', (ctx) => ctx.json(accounting.profitAndLoss()));
  route('GET', '/accounting/balance-sheet', 'accounting.view', (ctx) => ctx.json(accounting.balanceSheet()));
  route('GET', '/accounting/verify', 'accounting.view', (ctx) => ctx.json(accounting.verify()));
  route('GET', '/accounting/entries', 'accounting.view', (ctx) =>
    ctx.json(accounting.entries({ accountCode: ctx.query.account })),
  );
  route('GET', '/accounting/entries/:id', 'accounting.view', (ctx) => ctx.json(accounting.entryLines(ctx.params.id)));
  route('POST', '/accounting/journal', 'accounting.post', async (ctx) => {
    requireCap('accounting.post')(ctx);
    const b = await ctx.body();
    const e = accounting.postEntry({
      date: b.date,
      description: b.description,
      reference: b.reference,
      lines: b.lines,
      user: ctx.user,
    });
    auth.audit(ctx.user.id, ctx.user.username, 'JOURNAL_POST', 'journal_entries', e.id, e.doc_no);
    return ctx.json(e, 201);
  });

  route('GET', '/banks', 'accounting.view', (ctx) => ctx.json(banks.accounts()));
  route('GET', '/banks/transactions', 'accounting.view', (ctx) =>
    ctx.json(banks.transactions({ bankAccountId: ctx.query.bankAccountId, reconciled: ctx.query.reconciled })),
  );
  route('POST', '/banks/transactions', 'accounting.reconcile', async (ctx) => {
    const b = await ctx.body();
    return ctx.json({ id: banks.addManual({ ...b, user: ctx.user }) }, 201);
  });
  route('POST', '/banks/reconcile', 'accounting.reconcile', async (ctx) => {
    const b = await ctx.body();
    const recId = banks.reconcile({ ...b });
    auth.audit(ctx.user.id, ctx.user.username, 'BANK_RECONCILE', 'reconciliation', recId, '');
    return ctx.json({ id: recId }, 201);
  });
  route('GET', '/banks/reconciliations', 'accounting.view', (ctx) => ctx.json(banks.reconciliations()));
}
