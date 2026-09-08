// Tenant self-service + Control Tower credential management, on the shared
// database. Mirrors the graysale TenantProfileService but wired to the main
// ERP db so `/api/v1/tenant/profile` and `/api/v1/company-settings` work.
//
// Trust levels:
//   * update()      — the tenant OWNER editing their own company + login.
//                     A password change requires the current password.
//   * adminUpdate() — Control Tower super-admin override that force-resets the
//                     owner username / password without the current password.

import { hashPassword, verifyPassword } from '../auth.js';
import { findOwner, isTenantOwner } from './owner.js';

// company_settings columns the profile pages may edit.
const BUSINESS_FIELDS = ['trading_as', 'address', 'telephone', 'mobile', 'reg_number', 'tin_number', 'vat_number'];

// Resolve the single current tenant (or an explicit id).
function resolveTenant(db, tenantId) {
  if (tenantId) return String(tenantId);
  const row = db.prepare('SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1').get();
  return row ? String(row.id) : null;
}

class TenantProfileService {
  constructor(db, auth) {
    this.db = db;
    this.auth = auth;
  }

  _tenant(tenantId) {
    return this.db.prepare('SELECT id, company_name, owner_email, status FROM tenants WHERE id = ?').get(String(tenantId)) || null;
  }

  _owner(tenantId) {
    return findOwner(this.db, tenantId);
  }

  _business(tenantId) {
    return this.db.prepare(
      'SELECT trading_as, address, telephone, mobile, reg_number, tin_number, vat_number FROM company_settings WHERE id = 1 AND tenant_id = ?'
    ).get(String(tenantId)) || {};
  }

  get(tenantId) {
    const tenant = resolveTenant(this.db, tenantId);
    if (!tenant) return null;
    const t = this._tenant(tenant);
    if (!t) return null;
    const cs = this._business(tenant);
    const owner = this._owner(tenant);
    return {
      tenantId: t.id,
      company_name: t.company_name,
      owner_email: t.owner_email,
      status: t.status,
      owner_username: owner ? owner.username : '',
      owner_user_id: owner ? owner.id : null,
      trading_as: cs.trading_as || '',
      address: cs.address || '',
      telephone: cs.telephone || '',
      mobile: cs.mobile || '',
      reg_number: cs.reg_number || '',
      tin_number: cs.tin_number || '',
      vat_number: cs.vat_number || '',
    };
  }

  _mergeBusiness(tenant, payload, companyName) {
    const cur = this._business(tenant);
    const next = { company_name: cur.company_name || '' };
    for (const f of BUSINESS_FIELDS) next[f] = cur[f] || '';
    if (companyName !== undefined) next.company_name = companyName;
    for (const f of BUSINESS_FIELDS) {
      if (payload[f] !== undefined) next[f] = String(payload[f]);
    }
    return next;
  }

  _upsertBusiness(tenant, next) {
    this.db.prepare(`
      INSERT INTO company_settings (
        id, company_name, trading_as, address, telephone, mobile, reg_number,
        tin_number, vat_number, tenant_id, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        company_name = excluded.company_name, trading_as = excluded.trading_as,
        address = excluded.address, telephone = excluded.telephone,
        mobile = excluded.mobile, reg_number = excluded.reg_number,
        tin_number = excluded.tin_number, vat_number = excluded.vat_number,
        tenant_id = excluded.tenant_id, updated_at = datetime('now')
    `).run(
      next.company_name, next.trading_as, next.address, next.telephone,
      next.mobile, next.reg_number, next.tin_number, next.vat_number, String(tenant),
    );
  }

  // Owner self-service: strictly scoped to the caller's tenant; password change
  // requires the current password.
  update(payload, tenantId, actor) {
    const tenant = resolveTenant(this.db, tenantId);
    if (!tenant) { const e = new Error('TENANT_NOT_FOUND'); e.status = 404; throw e; }
    const t = this._tenant(tenant);
    if (!t) { const e = new Error('TENANT_NOT_FOUND'); e.status = 404; throw e; }
    const owner = this._owner(tenant);
    if (!owner) { const e = new Error('TENANT_OWNER_NOT_FOUND'); e.status = 404; throw e; }
    if (!isTenantOwner(this.db, tenant, actor)) { const e = new Error('OWNER_ONLY'); e.status = 403; throw e; }

    let companyName = t.company_name;
    if (payload.company_name !== undefined) {
      companyName = String(payload.company_name).trim();
      if (!companyName) { const e = new Error('COMPANY_NAME_REQUIRED'); e.status = 400; throw e; }
    }
    let ownerEmail = t.owner_email;
    if (payload.owner_email !== undefined) {
      ownerEmail = String(payload.owner_email).trim();
      if (!ownerEmail) { const e = new Error('OWNER_EMAIL_REQUIRED'); e.status = 400; throw e; }
    }

    let newUsername = owner.username;
    if (payload.owner_username !== undefined) {
      newUsername = String(payload.owner_username).trim();
      if (!newUsername) { const e = new Error('USERNAME_REQUIRED'); e.status = 400; throw e; }
      if (newUsername !== owner.username &&
          this.db.prepare('SELECT id FROM users WHERE username = ?').get(newUsername)) {
        const e = new Error('DUPLICATE_USERNAME'); e.status = 409; throw e;
      }
    }

    let newPassword = null;
    if (payload.new_password && String(payload.new_password).length > 0) {
      if (!payload.current_password) { const e = new Error('CURRENT_PASSWORD_REQUIRED'); e.status = 400; throw e; }
      const stored = this.db.prepare('SELECT password_hash FROM users WHERE id = ? AND tenant_id = ?').get(actor.id, String(tenant));
      if (!stored || !verifyPassword(payload.current_password, stored.password_hash)) {
        const e = new Error('INVALID_CURRENT_PASSWORD'); e.status = 400; throw e;
      }
      newPassword = String(payload.new_password);
    }

    const csSets = BUSINESS_FIELDS.filter((f) => payload[f] !== undefined);
    const nextBusiness = csSets.length ? this._mergeBusiness(payload, tenant, companyName) : null;

    const db = this.db;
    db.exec('BEGIN');
    try {
      db.prepare("UPDATE tenants SET company_name = ?, owner_email = ?, updated_at = datetime('now') WHERE id = ?")
        .run(companyName, ownerEmail, String(tenant));
      if (nextBusiness) this._upsertBusiness(tenant, nextBusiness);

      if (newUsername !== owner.username) {
        db.prepare('UPDATE users SET username = ? WHERE id = ? AND tenant_id = ?').run(newUsername, owner.id, String(tenant));
      }
      if (newPassword) {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND tenant_id = ?')
          .run(hashPassword(newPassword), owner.id, String(tenant));
        // Invalidate owner sessions so stale passwords are useless.
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(owner.id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    if (this.auth?.audit) {
      const changed = [];
      if (companyName !== t.company_name) changed.push('company_name');
      if (ownerEmail !== t.owner_email) changed.push('owner_email');
      if (csSets.length) changed.push('business_info');
      if (newUsername !== owner.username) changed.push('username');
      if (newPassword) changed.push('password');
      this.auth.audit(actor.id, actor.username, 'PROFILE_UPDATE', 'tenant', String(tenant), changed.join(','));
    }

    return this.get(tenant);
  }

  // Control Tower override (used by /api/v1/superadmin). Force resets never
  // require the current password. Returns null if the tenant does not exist.
  adminUpdate(id, payload, actor) {
    const tenant = String(id);
    if (!this._tenant(tenant)) return null;
    const owner = this._owner(tenant);

    if (payload.company_name !== undefined && !String(payload.company_name).trim()) { const e = new Error('COMPANY_NAME_REQUIRED'); e.status = 400; throw e; }
    if (payload.owner_email !== undefined && !String(payload.owner_email).trim()) { const e = new Error('OWNER_EMAIL_REQUIRED'); e.status = 400; throw e; }

    const companyName = payload.company_name !== undefined ? String(payload.company_name).trim() : (this._tenant(tenant).company_name);
    const ownerEmail = payload.owner_email !== undefined ? String(payload.owner_email).trim() : (this._tenant(tenant).owner_email);

    let newUsername = owner ? owner.username : '';
    if (payload.owner_username !== undefined) {
      newUsername = String(payload.owner_username).trim();
      if (!newUsername) { const e = new Error('USERNAME_REQUIRED'); e.status = 400; throw e; }
      if (!owner) { const e = new Error('TENANT_OWNER_NOT_FOUND'); e.status = 404; throw e; }
      if (newUsername !== owner.username && this.db.prepare('SELECT id FROM users WHERE username = ?').get(newUsername)) {
        const e = new Error('DUPLICATE_USERNAME'); e.status = 409; throw e;
      }
    }

    const csSets = BUSINESS_FIELDS.filter((f) => payload[f] !== undefined);
    const nextBusiness = csSets.length ? this._mergeBusiness(payload, tenant, companyName) : null;
    const wantsPassword = !!payload.new_password && String(payload.new_password).length > 0;

    const db = this.db;
    db.exec('BEGIN');
    try {
      db.prepare("UPDATE tenants SET company_name = ?, owner_email = ?, updated_at = datetime('now') WHERE id = ?")
        .run(companyName, ownerEmail, String(tenant));
      if (nextBusiness) this._upsertBusiness(tenant, nextBusiness);
      if (owner && newUsername !== owner.username) {
        db.prepare('UPDATE users SET username = ? WHERE id = ? AND tenant_id = ?').run(newUsername, owner.id, String(tenant));
      }
      if (wantsPassword) {
        if (!owner) { const e = new Error('TENANT_OWNER_NOT_FOUND'); e.status = 404; throw e; }
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND tenant_id = ?')
          .run(hashPassword(String(payload.new_password)), owner.id, String(tenant));
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(owner.id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    if (this.auth?.audit) {
      this.auth.audit(actor?.id, actor?.username, 'TENANT_EDIT', 'tenant', String(tenant), 'super-admin profile update');
    }
    return this.get(tenant);
  }
}

class CompanySettingsService {
  constructor(db) { this.db = db; }

  get(tenantId) {
    const tenant = resolveTenant(this.db, tenantId);
    if (!tenant) return null;
    const row = this.db.prepare('SELECT * FROM company_settings WHERE id = 1 AND tenant_id = ?').get(String(tenant));
    if (!row) {
      return { company_name: '', trading_as: '', tagline: '', address: '', telephone: '', mobile: '', reg_number: '', tin_number: '', vat_number: '', banking_details: [] };
    }
    let banks = [];
    try { const a = JSON.parse(row.banking_details || '[]'); if (Array.isArray(a)) banks = a; } catch { /* ignore */ }
    return {
      company_name: row.company_name || '', trading_as: row.trading_as || '', tagline: row.tagline || '',
      address: row.address || '', telephone: row.telephone || '', mobile: row.mobile || '',
      reg_number: row.reg_number || '', tin_number: row.tin_number || '', vat_number: row.vat_number || '',
      banking_details: banks, updated_at: row.updated_at, tenant_id: row.tenant_id,
    };
  }

  update(payload = {}, tenantId) {
    const tenant = resolveTenant(this.db, tenantId);
    if (!tenant) { const e = new Error('TENANT_NOT_FOUND'); e.status = 404; throw e; }
    const banks = Array.isArray(payload.banking_details) ? payload.banking_details : [];
    this.db.prepare(`
      INSERT INTO company_settings (
        id, company_name, trading_as, tagline, address, telephone, mobile,
        reg_number, tin_number, vat_number, banking_details, tenant_id, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        company_name = excluded.company_name, trading_as = excluded.trading_as,
        tagline = excluded.tagline, address = excluded.address,
        telephone = excluded.telephone, mobile = excluded.mobile,
        reg_number = excluded.reg_number, tin_number = excluded.tin_number,
        vat_number = excluded.vat_number, banking_details = excluded.banking_details,
        tenant_id = excluded.tenant_id, updated_at = datetime('now')
    `).run(
      payload.company_name || '', payload.trading_as || '', payload.tagline || '',
      payload.address || '', payload.telephone || '', payload.mobile || '',
      payload.reg_number || '', payload.tin_number || '', payload.vat_number || '',
      JSON.stringify(banks), String(tenant),
    );
    return this.get(tenant);
  }
}

export { TenantProfileService, CompanySettingsService, resolveTenant };
export default TenantProfileService;
