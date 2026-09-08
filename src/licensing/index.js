// Licensing / Control Tower service facade. Wires the tenant registry, product
// key manager, platform metrics, and the current-tenant license context onto
// one database handle. Super-admin API routes and the tenant-enforcement
// middleware both consume this.

import { TenantsService } from './tenants.js';
import { ProductKeysService } from './keys.js';
import { TenantProfileService, CompanySettingsService } from './tenantProfile.js';

export { TenantsService } from './tenants.js';
export { ProductKeysService } from './keys.js';
export { TenantProfileService, CompanySettingsService } from './tenantProfile.js';
export { makeEnforceTenantStatus } from './enforceTenantStatus.js';

export class LicensingService {
  constructor(db, auth) {
    this.db = db;
    this.tenants = new TenantsService(db);
    this.keys = new ProductKeysService(db);
    this.profile = new TenantProfileService(db, auth);
    this.company = new CompanySettingsService(db);
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
}
