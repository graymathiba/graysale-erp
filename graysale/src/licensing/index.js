// Licensing / Control Tower service facade. Wires the tenant registry, product
// key manager, platform metrics, and the current-tenant license context onto
// one database handle. Super-admin API routes and the tenant-enforcement
// middleware both consume this.

import { TenantsService } from './tenants.js';
import { ProductKeysService } from './keys.js';

export { TenantsService } from './tenants.js';
export { ProductKeysService } from './keys.js';
export { makeEnforceTenantStatus } from './enforceTenantStatus.js';

export class LicensingService {
  constructor(db) {
    this.db = db;
    this.tenants = new TenantsService(db);
    this.keys = new ProductKeysService(db);
  }

  // The tenant this single-instance deployment currently runs as. In a fleet,
  // resolve from a request header / hostname instead of the first row.
  currentTenant() {
    return this.tenants.list({})[0] || null;
  }

  // Platform overview metrics for Control Tower View C.
  overview() {
    const tenants = this.tenants.list({});
    const active = tenants.filter((t) => t.status === 'ACTIVE' && !t.isExpired).length;
    const blocked = tenants.filter((t) => t.status === 'BLOCKED').length;
    const expired = tenants.filter((t) => t.status === 'EXPIRED' || (t.status === 'ACTIVE' && t.isExpired)).length;
    const pending = tenants.filter((t) => t.status === 'PENDING_KEY' || t.status === 'PENDING_ACTIVATION').length;
    return {
      totalCompanies: tenants.length,
      activeCompanies: active,
      blockedInstances: blocked,
      expiredAccounts: expired,
      pendingKeys: pending,
      ...this.keys.metrics(),
    };
  }

  // Shops with a session that checked in within `windowMs` (default 5 min).
  // Backs the KeyMaster "who is connected" screen. Presence comes from
  // sessions.last_seen_at (throttled writes in auth), never from raw tokens.
  connected(windowMs = 5 * 60_000) {
    const cutoff = Date.now() - windowMs;
    const rows = this.db
      .prepare(
        `SELECT u.tenant_id AS tenant_id, t.company_name AS company_name, t.status AS status,
                COUNT(*) AS sessions, MAX(s.last_seen_at) AS last_seen_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN tenants t ON t.id = u.tenant_id
         WHERE s.last_seen_at >= ? AND s.expires_at > ?
         GROUP BY u.tenant_id
         ORDER BY last_seen_at DESC`,
      )
      .all(cutoff, new Date().toISOString());
    return {
      windowMs,
      checkedAt: new Date().toISOString(),
      tenants: rows.map((r) => ({
        tenantId: r.tenant_id || null,
        companyName: r.company_name || '(platform)',
        status: r.status || null,
        sessions: Number(r.sessions) || 0,
        lastSeenAt: Number(r.last_seen_at) || null,
      })),
    };
  }
}
