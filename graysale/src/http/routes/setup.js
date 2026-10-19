// First-run environment / storage setup. Runs before auth: a brand-new or
// freshly-moved install must pick its data home before ANY tenant screen
// opens. `/setup/*` is never storage-gated (see the dispatcher).

export function registerSetup({ route, services: S, PUBLIC }) {
  route('GET', '/setup/status', PUBLIC, (ctx) => {
    const storage = S.storage;
    return ctx.json({ storage: storage.status(), fileView: storage.fileView() });
  });

  route('POST', '/setup/storage', PUBLIC, async (ctx) => {
    const b = await ctx.body();
    const result = S.storage.setup({ root: b.root || null, kind: b.kind || 'local' });
    if (result.reload) {
      ctx.json(result);
      if (S.storage.emitRelocate) S.storage.emitRelocate();
      return;
    }
    return ctx.json(result);
  });

  route('POST', '/setup/storage/adopt', PUBLIC, async (ctx) => {
    const result = S.storage.adopt();
    if (result.reload && S.storage.emitRelocate) S.storage.emitRelocate();
    return ctx.json(result);
  });

  // ----- storage diagnostics (any signed-in user; read-only) -----
  route('GET', '/storage/status', null, (ctx) => {
    if (!ctx.user) return ctx.json({ error: 'UNAUTHORIZED' }, 401);
    const storage = S.storage;
    const view = storage.fileView();
    // For the called tenant: how much of the data belongs to them.
    const myTenant = ctx.tenantId ? view.tenants.find((t) => t.tenant_id === ctx.tenantId) || null : null;
    return ctx.json({ storage: storage.status(), fileView: view, myTenant });
  });
}
