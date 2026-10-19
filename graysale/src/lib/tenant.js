// Tenant context helpers. GraySale runs one SQLite instance per tenant, so the
// normal path is: the signed-in user carries `users.tenant_id`, every tenant
// route binds to it, and every business query is filtered by `tenant_id = ?`.
//
// `defaultTenantId` resolves the instance's "current" tenant (first row) and is
// used to (a) backfill legacy rows on migration and (b) give direct service
// calls — tests, seeds, scripts — a sensible tenant so data is never orphaned.

export function defaultTenantId(db) {
  const row = db.prepare('SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1').get();
  return row ? row.id : null;
}

// Prefer an explicit tenant (from the request scope); fall back to the
// instance tenant so service-level callers stay deterministic.
export function resolveTenantId(db, explicit) {
  return explicit || defaultTenantId(db);
}

export default { defaultTenantId, resolveTenantId };
