// Tenant profile + owner credential management.
//
// Two trust levels share one service:
//   * update()        — the tenant OWNER editing their own company + login
//                       details. Strictly scoped to their tenant id, and a
//                       password change requires the current password.
//   * adminUpdate()   — Control Tower super-admin override: edits company /
//                       contact info, and can force-reset the owner username
//                       and password without the current password.

import { forbidden, notFound, conflict, badRequest } from '../lib/errors.js';
import { resolveTenantId } from '../lib/tenant.js';
import { tx } from '../db/database.js';
import { hashPassword, verifyPassword } from './auth.js';

// company_settings columns the profile pages may edit.
const BUSINESS_FIELDS = ['trading_as', 'address', 'telephone', 'mobile', 'reg_number', 'tin_number', 'vat_number'];

export class TenantProfileService {
  constructor(db, auth) {
    this.db = db;
    this.auth = auth;
  }

  _tenant(tenantId) {
    return this.db.prepare('SELECT id, company_name, owner_email, status FROM tenants WHERE id = ?').get(tenantId) || null;
  }

  _owner(tenantId) {
    return this.db.prepare(
      "SELECT id, username, password_hash, full_name, role, active FROM users WHERE tenant_id = ? AND role = 'owner' LIMIT 1"
    ).get(tenantId) || null;
  }

  // Merge the profile save into the (shared, id=1) company_settings row the
  // same way CompanySettingsService does, so business fields always persist
  // even when the row did not exist yet.
  _mergeBusiness(payload, tenant, companyName) {
    const cur = this.db.prepare(
      'SELECT company_name, trading_as, address, telephone, mobile, reg_number, tin_number, vat_number FROM company_settings WHERE id = 1 AND tenant_id = ?'
    ).get(tenant) || {};
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
        id, company_name, trading_as, address, telephone, mobile, reg_number, tin_number, vat_number,
        updated_at, tenant_id
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(id) DO UPDATE SET
        company_name = excluded.company_name,
        trading_as = excluded.trading_as,
        address = excluded.address,
        telephone = excluded.telephone,
        mobile = excluded.mobile,
        reg_number = excluded.reg_number,
        tin_number = excluded.tin_number,
        vat_number = excluded.vat_number,
        updated_at = datetime('now'),
        tenant_id = excluded.tenant_id
    `).run(
      next.company_name, next.trading_as, next.address, next.telephone,
      next.mobile, next.reg_number, next.tin_number, next.vat_number, tenant,
    );
  }

  get(tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const t = this._tenant(tenant);
    if (!t) throw notFound('TENANT_NOT_FOUND');
    const cs = this.db.prepare(
      'SELECT trading_as, address, telephone, mobile, reg_number, tin_number, vat_number FROM company_settings WHERE id = 1 AND tenant_id = ?'
    ).get(tenant) || {};
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

  // Tenant self-service. Every write is scoped `WHERE id = ?` to the caller's
  // tenant; owner username/password changes additionally require the caller to
  // BE the tenant owner (and know the current password to set a new one).
  update(payload, tenantId, actor) {
    const tenant = resolveTenantId(this.db, tenantId);
    const t = this._tenant(tenant);
    if (!t) throw notFound('TENANT_NOT_FOUND');
    const owner = this._owner(tenant);
    if (!owner) throw notFound('TENANT_OWNER_NOT_FOUND');
    if (!actor || actor.id !== owner.id) throw forbidden('OWNER_ONLY');

    const changed = [];

    let companyName = t.company_name;
    if (payload.company_name !== undefined) {
      companyName = String(payload.company_name).trim();
      if (!companyName) throw badRequest('COMPANY_NAME_REQUIRED');
    }
    let ownerEmail = t.owner_email;
    if (payload.owner_email !== undefined) {
      ownerEmail = String(payload.owner_email).trim();
      if (!ownerEmail) throw badRequest('OWNER_EMAIL_REQUIRED');
    }

    let newUsername = owner.username;
    if (payload.owner_username !== undefined) {
      newUsername = String(payload.owner_username).trim();
      if (!newUsername) throw badRequest('USERNAME_REQUIRED');
      if (newUsername !== owner.username) {
        if (this.db.prepare('SELECT id FROM users WHERE username = ?').get(newUsername)) {
          throw conflict(`DUPLICATE_USERNAME: ${newUsername}`);
        }
      }
    }

    let newPassword = null;
    if (payload.new_password && String(payload.new_password).length > 0) {
      if (!payload.current_password) throw badRequest('CURRENT_PASSWORD_REQUIRED');
      const stored = this.db.prepare('SELECT password_hash FROM users WHERE id = ? AND tenant_id = ?').get(actor.id, tenant);
      if (!stored || !verifyPassword(payload.current_password, stored.password_hash)) {
        throw badRequest('INVALID_CURRENT_PASSWORD');
      }
      newPassword = String(payload.new_password);
    }

    const csSets = [];
    for (const f of BUSINESS_FIELDS) {
      if (payload[f] !== undefined) csSets.push(f);
    }
    const nextBusiness = this._mergeBusiness(payload, tenant, companyName);

    return tx(this.db, () => {
      this.db.prepare(
        "UPDATE tenants SET company_name = ?, owner_email = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(companyName, ownerEmail, tenant);
      if (companyName !== t.company_name) changed.push('company_name');
      if (ownerEmail !== t.owner_email) changed.push('owner_email');

      if (csSets.length) {
        this._upsertBusiness(tenant, nextBusiness);
        changed.push('business_info');
      }

      if (newUsername !== owner.username) {
        this.db.prepare('UPDATE users SET username = ? WHERE id = ? AND tenant_id = ?').run(newUsername, owner.id, tenant);
        changed.push('username');
      }

      if (newPassword) {
        this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND tenant_id = ?')
          .run(hashPassword(newPassword), owner.id, tenant);
        // Invalidate any existing owner sessions so stale passwords are useless.
        this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(owner.id);
        changed.push('password');
      }

      const profile = this.get(tenant);
      this.auth.audit(actor.id, actor.username, 'PROFILE_UPDATE', 'tenant', tenant, changed.join(','));
      return profile;
    });
  }

  // Control Tower override (super-admin). Never requires the current password.
  // Returns null if the tenant does not exist.
  adminUpdate(id, payload, actor) {
    const tenant = String(id);
    const t = this._tenant(tenant);
    if (!t) return null;
    const owner = this._owner(tenant);

    if (payload.company_name !== undefined && !String(payload.company_name).trim()) throw badRequest('COMPANY_NAME_REQUIRED');
    if (payload.owner_email !== undefined && !String(payload.owner_email).trim()) throw badRequest('OWNER_EMAIL_REQUIRED');

    const companyName = payload.company_name !== undefined ? String(payload.company_name).trim() : t.company_name;
    const ownerEmail = payload.owner_email !== undefined ? String(payload.owner_email).trim() : t.owner_email;

    let newUsername = owner ? owner.username : '';
    if (payload.owner_username !== undefined) {
      newUsername = String(payload.owner_username).trim();
      if (!newUsername) throw badRequest('USERNAME_REQUIRED');
      if (!owner) throw notFound('TENANT_OWNER_NOT_FOUND');
      if (newUsername !== owner.username && this.db.prepare('SELECT id FROM users WHERE username = ?').get(newUsername)) {
        throw conflict(`DUPLICATE_USERNAME: ${newUsername}`);
      }
    }

    const csSets = [];
    for (const f of BUSINESS_FIELDS) {
      if (payload[f] !== undefined) csSets.push(f);
    }
    const nextBusiness = this._mergeBusiness(payload, tenant, companyName);
    const wantsPassword = !!payload.new_password && String(payload.new_password).length > 0;

    tx(this.db, () => {
      this.db.prepare(
        "UPDATE tenants SET company_name = ?, owner_email = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(companyName, ownerEmail, tenant);

      if (csSets.length) {
        this._upsertBusiness(tenant, nextBusiness);
      }

      if (owner && newUsername !== owner.username) {
        this.db.prepare('UPDATE users SET username = ? WHERE id = ? AND tenant_id = ?').run(newUsername, owner.id, tenant);
      }
      if (wantsPassword) {
        if (!owner) throw notFound('TENANT_OWNER_NOT_FOUND');
        this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND tenant_id = ?')
          .run(hashPassword(String(payload.new_password)), owner.id, tenant);
        this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(owner.id);
      }
      return null;
    });

    this.auth.audit(actor.id, actor.username, 'TENANT_EDIT', 'tenant', tenant, 'super-admin profile update');
    return this.get(tenant);
  }
}

export default TenantProfileService;