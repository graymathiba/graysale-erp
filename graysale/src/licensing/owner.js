// Tenant owner resolution, shared by the Control Tower and tenant self-service
// paths.
//
// The merged ERP stores accounts with the main role model (cashier / manager /
// admin), while the standalone GraySale used an explicit `owner` role. To stay
// compatible with both, "owner" resolves as:
//   1. an explicit `role = 'owner'` account for the tenant, or
//   2. the tenant's first `role = 'admin'` account (the de-facto operator of a
//      single-instance deployment such as the bootstrapped default admin).

export function findOwner(db, tenantId) {
  const t = String(tenantId);
  const explicit = db
    .prepare(
      "SELECT id, username, password_hash, full_name, role, active FROM users WHERE tenant_id = ? AND role = 'owner' LIMIT 1",
    )
    .get(t);
  if (explicit) return explicit;
  return (
    db
      .prepare(
        "SELECT id, username, password_hash, full_name, role, active FROM users WHERE tenant_id = ? AND role = 'admin' ORDER BY id ASC LIMIT 1",
      )
      .get(t) || null
  );
}

// A user acts as the tenant owner when they resolve to the owner account.
export function isTenantOwner(db, tenantId, user) {
  if (!user) return false;
  const owner = findOwner(db, tenantId);
  return !!owner && Number(owner.id) === Number(user.id);
}

export default findOwner;
