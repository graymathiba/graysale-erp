// User administration and the audit trail.

export function registerUsers({ route, services: S, requireCap }) {
  const { auth } = S;

  route('GET', '/users', 'users.view', (ctx) => ctx.json(auth.listUsers(ctx.tenantId)));
  route('POST', '/users', 'users.manage', async (ctx) => {
    requireCap('users.manage')(ctx);
    const b = await ctx.body();
    const id = auth.createUser({ ...b, fullName: b.fullName ?? b.full_name, tenantId: ctx.tenantId });
    auth.audit(ctx.user.id, ctx.user.username, 'USER_CREATE', 'user', id, b.username);
    return ctx.json({ id }, 201);
  });
  route('PUT', '/users/:id', 'users.manage', async (ctx) => {
    requireCap('users.manage')(ctx);
    const b = await ctx.body();
    auth.updateUser(ctx.params.id, b, ctx.tenantId);
    auth.audit(ctx.user.id, ctx.user.username, 'USER_UPDATE', 'user', ctx.params.id, JSON.stringify(b));
    return ctx.json({ ok: true });
  });
  route('DELETE', '/users/:id', 'users.delete', async (ctx) => {
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
  route('GET', '/audit', 'users.view', (ctx) => ctx.json(auth.listAudit(ctx.query.limit)));
}
