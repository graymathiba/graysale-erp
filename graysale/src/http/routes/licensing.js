// Licensing / Control Tower routes: super-admin tenant + product-key
// management, and the tenant-facing activation endpoints.

export function registerLicensing({ route, services: S, licensing, superAdmin, auth, PUBLIC }) {
  route('GET', '/superadmin/overview', null, async (ctx) => {
    superAdmin(ctx);
    return ctx.json(licensing.overview());
  });

  // KeyMaster: which shops have a live session right now (presence window
  // configurable ?windowMs=, max 1h). Read-only, super-admin only.
  route('GET', '/superadmin/connected', null, async (ctx) => {
    superAdmin(ctx);
    const raw = Number(ctx.query.windowMs);
    const windowMs = Number.isFinite(raw) && raw >= 60_000 && raw <= 3600_000 ? raw : 5 * 60_000;
    return ctx.json(licensing.connected(windowMs));
  });

  route('GET', '/superadmin/tenants', null, async (ctx) => {
    superAdmin(ctx);
    return ctx.json(licensing.tenants.list({ search: ctx.query.search, status: ctx.query.status }));
  });
  route('POST', '/superadmin/tenants', null, async (ctx) => {
    superAdmin(ctx);
    const b = await ctx.body();
    const t = licensing.tenants.create({
      companyName: b.companyName,
      ownerEmail: b.ownerEmail,
      ownerUsername: b.ownerUsername,
      password: b.password,
      status: b.status || 'PENDING_KEY',
      licenseKey: b.licenseKey,
      licenseExpiresAt: b.licenseExpiresAt,
      storage: b.storage || (S.storage ? S.storage.tenantDescriptor() : null),
    });
    auth.audit(ctx.user.id, ctx.user.username, 'TENANT_CREATE', 'tenant', t.id, t.company_name);
    return ctx.json(t, 201);
  });
  route('GET', '/superadmin/tenants/:id', null, async (ctx) => {
    superAdmin(ctx);
    const t = licensing.tenants.get(ctx.params.id);
    if (!t) return ctx.json({ error: 'TENANT_NOT_FOUND' }, 404);
    return ctx.json(t);
  });
  route('POST', '/superadmin/tenants/:id/toggle', null, async (ctx) => {
    superAdmin(ctx);
    const t = licensing.tenants.toggleAccess(ctx.params.id);
    if (!t) return ctx.json({ error: 'TENANT_NOT_FOUND' }, 404);
    auth.audit(
      ctx.user.id,
      ctx.user.username,
      t.status === 'BLOCKED' ? 'TENANT_BLOCK' : 'TENANT_UNBLOCK',
      'tenant',
      t.id,
      t.company_name,
    );
    return ctx.json(t);
  });
  route('POST', '/superadmin/tenants/:id/extend', null, async (ctx) => {
    superAdmin(ctx);
    const b = await ctx.body();
    const days = Number(b.days);
    if (!Number.isInteger(days) || days <= 0) return ctx.json({ error: 'INVALID_DAYS' }, 400);
    const t = licensing.tenants.extend(ctx.params.id, days);
    if (!t) return ctx.json({ error: 'TENANT_NOT_FOUND' }, 404);
    auth.audit(ctx.user.id, ctx.user.username, 'TENANT_EXTEND', 'tenant', t.id, `${days} days`);
    return ctx.json(t);
  });
  route('PUT', '/superadmin/tenants/:id', null, async (ctx) => {
    superAdmin(ctx);
    const b = await ctx.body();
    const t = S.tenantProfile.adminUpdate(ctx.params.id, b, ctx.user);
    if (!t) return ctx.json({ error: 'TENANT_NOT_FOUND' }, 404);
    if (b.storage !== undefined) licensing.tenants.update(ctx.params.id, { storage: b.storage });
    return ctx.json(licensing.tenants.get(ctx.params.id));
  });

  route('GET', '/superadmin/keys', null, async (ctx) => {
    superAdmin(ctx);
    return ctx.json(licensing.keys.list({ status: ctx.query.status, search: ctx.query.search }));
  });
  route('POST', '/superadmin/keys/generate', null, async (ctx) => {
    superAdmin(ctx);
    const b = await ctx.body();
    const r = licensing.keys.generate({ planType: b.planType, count: b.count || 1, generatedBy: ctx.user.id });
    auth.audit(
      ctx.user.id,
      ctx.user.username,
      'KEY_GENERATE',
      'product_key',
      null,
      `${r.count} x ${r.keys[0]?.planType}`,
    );
    return ctx.json(r, 201);
  });
  route('POST', '/superadmin/keys/check', null, async (ctx) => {
    superAdmin(ctx);
    const b = await ctx.body();
    const k = licensing.keys.getByCode(b.keyCode);
    if (!k) return ctx.json({ error: 'INVALID_KEY' }, 404);
    return ctx.json(k);
  });
  route('POST', '/superadmin/keys/:id/revoke', null, async (ctx) => {
    superAdmin(ctx);
    const k = licensing.keys.revoke(ctx.params.id);
    if (!k) return ctx.json({ error: 'KEY_NOT_FOUND' }, 404);
    auth.audit(ctx.user.id, ctx.user.username, 'KEY_REVOKE', 'product_key', k.id, k.key_code);
    return ctx.json(k);
  });

  // Tenant-facing key redemption (bypasses the tenant gate so a lapsed or
  // pending-key instance can always reactivate itself).
  route('POST', '/license/activate', PUBLIC, async (ctx) => {
    const b = await ctx.body();
    const keyCode = b.keyCode || b.key_code;
    if (!keyCode) return ctx.json({ error: 'MISSING_FIELD:keyCode' }, 400);
    const tenant = licensing.currentTenant();
    if (!tenant) return ctx.json({ error: 'NO_TENANT' }, 404);
    const result = licensing.keys.redeem(keyCode, tenant.id);
    if (!result.ok) return ctx.json(result, result.code === 'TENANT_NOT_FOUND' ? 404 : 400);
    auth.audit(ctx.user?.id, ctx.user?.username, 'LICENSE_ACTIVATE', 'tenant', tenant.id, keyCode);
    return ctx.json({ ok: true, tenant: result.tenant });
  });

  // Current tenant's license status — used by the /activate-license gate on
  // first login. Always readable (no auth gate): shows whether activation is
  // required and what the activity blocker returns before performing work.
  route('GET', '/license/status', PUBLIC, (ctx) => {
    const tenant = licensing.currentTenant();
    if (!tenant) return ctx.json({ error: 'NO_TENANT' }, 404);
    const blocked =
      tenant.status === 'PENDING_KEY' || tenant.status === 'PENDING_ACTIVATION' || tenant.status === 'BLOCKED';
    return ctx.json({
      status: tenant.status,
      activated: !blocked,
      activationRequired: blocked,
      companyName: tenant.company_name,
      licenseKey: tenant.license_key,
      expiresAt: tenant.license_expires_at,
    });
  });
}
