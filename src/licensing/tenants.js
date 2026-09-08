// Tenant registry service for the Control Tower. Operates on the global
// `tenants` table, independent of any single tenant's data (super-admin scope).
// UUID text ids keep the schema portable across SQLite instances.

import { uuid } from '../db/database.js';
import { hashPassword } from '../auth.js';
import { findOwner } from './owner.js';

const VALID_STATUSES = new Set(['ACTIVE', 'BLOCKED', 'EXPIRED', 'PENDING_KEY', 'PENDING_ACTIVATION']);

export class TenantsService {
  constructor(db) {
    this.db = db;
  }

  list({ search = '', status = null } = {}) {
    const conds = [];
    const params = [];
    if (search) {
      conds.push('(LOWER(company_name) LIKE ? OR LOWER(owner_email) LIKE ?)');
      const like = `%${String(search).toLowerCase()}%`;
      params.push(like, like);
    }
    if (status) {
      conds.push('status = ?');
      params.push(status);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM tenants ${where} ORDER BY created_at DESC`
    ).all(...params).map((t) => this._decorate(t));
  }

  get(id) {
    if (!id) return null;
    const row = this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(String(id));
    return row ? this._decorate(row) : null;
  }

  // New tenants start PENDING_ACTIVATION so their first login must redeem a
  // product key before any ERP screen is reachable.
  create({ companyName, ownerEmail, status = 'PENDING_ACTIVATION', licenseKey = null, licenseExpiresAt = null }) {
    if (!companyName) throw new Error('COMPANY_NAME_REQUIRED');
    if (!ownerEmail) throw new Error('OWNER_EMAIL_REQUIRED');
    if (!VALID_STATUSES.has(status)) throw new Error('INVALID_STATUS');
    // license key uniqueness is delegated to the shared product_keys table.
    const id = uuid();
    this.db.prepare(
      `INSERT INTO tenants (id, company_name, owner_email, status, license_key, license_expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, companyName, ownerEmail, status, licenseKey ?? null, licenseExpiresAt ?? null);
    return this.get(id);
  }

  setStatus(id, status) {
    if (!VALID_STATUSES.has(status)) throw new Error('INVALID_STATUS');
    this.db.prepare(
      `UPDATE tenants SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(status, String(id));
    return this.get(id);
  }

  toggleAccess(id) {
    const t = this.get(id);
    if (!t) return null;
    const next = t.status === 'BLOCKED' ? 'ACTIVE' : 'BLOCKED';
    return this.setStatus(id, next);
  }

  // Manually extend a tenant's subscription validity by N days from either the
  // current expiry (if still in the future) or now (if lapsed/absent).
  extend(id, days) {
    const n = Number(days);
    if (!Number.isInteger(n) || n <= 0) throw new Error('INVALID_DAYS');
    const t = this.get(id);
    if (!t) return null;
    const base = t.license_expires_at && new Date(t.license_expires_at).getTime() > Date.now()
      ? new Date(t.license_expires_at)
      : new Date();
    base.setDate(base.getDate() + n);
    const expires = base.toISOString();
    this.db.prepare(
      `UPDATE tenants SET license_expires_at = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(expires, String(id));
    // Extending a pending/lapsed tenant re-activates it.
    if (t.status === 'EXPIRED' || t.status === 'PENDING_KEY' || t.status === 'PENDING_ACTIVATION') {
      this.db.prepare(`UPDATE tenants SET status = 'ACTIVE', updated_at = datetime('now') WHERE id = ?`).run(String(id));
    }
    return this.get(id);
  }

  update(id, fields) {
    const t = this.get(id);
    if (!t) return null;
    const sets = [];
    const params = [];
    if (fields.companyName !== undefined) { sets.push('company_name = ?'); params.push(fields.companyName); }
    if (fields.ownerEmail !== undefined) { sets.push('owner_email = ?'); params.push(fields.ownerEmail); }
    if (fields.status !== undefined) {
      if (!VALID_STATUSES.has(fields.status)) throw new Error('INVALID_STATUS');
      sets.push('status = ?'); params.push(fields.status);
    }
    const hasUserChanges =
      (fields.owner_username !== undefined) ||
      (fields.new_password !== undefined) ||
      (fields.address !== undefined) ||
      (fields.telephone !== undefined) ||
      (fields.mobile !== undefined) ||
      (fields.trading_as !== undefined);
    if (!sets.length && !hasUserChanges) return t;
    if (sets.length) {
      sets.push("updated_at = datetime('now')");
      params.push(String(id));
      this.db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }

    // Owner user overrides (Control Tower credential management): change the
    // owner username and/or force a password reset without the current password.
    const owner = findOwner(this.db, String(id));
    if (owner && (fields.owner_username !== undefined || fields.new_password !== undefined)) {
      const uSets = []; const uVals = [];
      if (fields.owner_username !== undefined && String(fields.owner_username).trim()) {
        const name = String(fields.owner_username).trim();
        const dup = this.db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(name, owner.id);
        if (dup) throw new Error('DUPLICATE_USERNAME');
        uSets.push('username = ?'); uVals.push(name);
      }
      if (fields.new_password !== undefined && String(fields.new_password)) {
        uSets.push('password_hash = ?'); uVals.push(hashPassword(String(fields.new_password)));
      }
      if (uSets.length) {
        uVals.push(owner.id);
        this.db.prepare(`UPDATE users SET ${uSets.join(', ')} WHERE id = ?`).run(...uVals);
      }
    }

    // Business info (address / telephone / mobile / trading_as) merges into the
    // tenant's company_settings row for the self-service pages.
    const biz = {};
    if (fields.address !== undefined) biz.address = String(fields.address);
    if (fields.telephone !== undefined) biz.telephone = String(fields.telephone);
    if (fields.mobile !== undefined) biz.mobile = String(fields.mobile);
    if (fields.trading_as !== undefined) biz.trading_as = String(fields.trading_as);
    if (Object.keys(biz).length) this._mergeBusiness(String(id), biz);

    return this.get(id);
  }

  // Upsert contact/business fields into the tenant's company_settings row.
  _mergeBusiness(tenant, fields) {
    const current = this.db.prepare(
      'SELECT * FROM company_settings WHERE id = 1 AND tenant_id = ?'
    ).get(String(tenant)) || {};
    const next = {
      company_name: current.company_name || '', trading_as: current.trading_as || '',
      tagline: current.tagline || '', address: current.address || '',
      telephone: current.telephone || '', mobile: current.mobile || '',
      reg_number: current.reg_number || '', tin_number: current.tin_number || '',
      vat_number: current.vat_number || '', banking_details: current.banking_details || '[]',
    };
    for (const k of Object.keys(fields)) if (fields[k] !== undefined) next[k] = fields[k];
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
      next.company_name, next.trading_as, next.tagline, next.address, next.telephone,
      next.mobile, next.reg_number, next.tin_number, next.vat_number, next.banking_details,
      String(tenant),
    );
  }

  _decorate(t) {
    const users = this.db.prepare('SELECT COUNT(*) AS c FROM users WHERE tenant_id = ?').get(t.id);
    const owner = findOwner(this.db, t.id);
    return {
      ...t,
      activeUsers: users ? users.c : 0,
      owner_username: owner ? owner.username : null,
      isExpired: Boolean(t.license_expires_at) && new Date(t.license_expires_at).getTime() < Date.now(),
    };
  }
}
