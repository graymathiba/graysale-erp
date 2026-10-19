// Session endpoints: login (rate-limited), logout, self-service tenant
// registration, forced first-login password change and the session probe.

export function registerAuth({ route, services: S, PUBLIC }) {
  const { auth } = S;

  route('POST', '/auth/login', PUBLIC, async (ctx) => {
    const b = await ctx.body();
    const r = auth.login(b);
    // 429 distinguishes "locked out by brute-force guard" from bad credentials.
    return ctx.json(r, r.ok ? 200 : r.error === 'RATE_LIMITED' ? 429 : 401);
  });
  route('POST', '/auth/logout', PUBLIC, (ctx) => {
    auth.logout(ctx.token);
    return ctx.json({ ok: true });
  });
  route('POST', '/auth/register-tenant', PUBLIC, async (ctx) => {
    const b = await ctx.body();
    try {
      const r = auth.registerTenant({
        companyName: b.companyName || b.company_name,
        username: b.username,
        email: b.email,
        password: b.password,
      });
      return ctx.json(r, 201);
    } catch (e) {
      const msg = String(e.message || e);
      const code = msg.startsWith('DUPLICATE_') || msg.includes('REQUIRED') || msg.includes('TOO_SHORT') ? 400 : 500;
      return ctx.json({ ok: false, error: msg }, code);
    }
  });
  route('POST', '/auth/set-password', PUBLIC, async (ctx) => {
    const b = await ctx.body();
    if (!b.token && !ctx.user) return ctx.json({ ok: false, error: 'UNAUTHORIZED' }, 401);
    try {
      const targetUser = ctx.user || auth.userForToken(b.token);
      if (!targetUser) return ctx.json({ ok: false, error: 'INVALID_SESSION' }, 401);
      // The caller's own session stays valid — every OTHER session for this
      // user is revoked by setPassword.
      const callerToken = ctx.token || b.token || null;
      auth.setPassword(targetUser.id, b.password, callerToken);
      return ctx.json({ ok: true });
    } catch (e) {
      const msg = String(e.message || e);
      const code = msg.includes('PASSWORD_TOO_SHORT') ? 400 : 500;
      return ctx.json({ ok: false, error: msg }, code);
    }
  });
  route('GET', '/auth/me', null, (ctx) => {
    if (!ctx.user) return ctx.json({ error: 'UNAUTHORIZED' }, 401);
    return ctx.json({ user: ctx.user, tenant: auth.tenantForUser(ctx.user) });
  });
}
