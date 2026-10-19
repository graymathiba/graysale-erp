// Tenant registry service for the Control Tower. Operates on the global
// `tenants` table, independent of any single tenant's data (super-admin scope).
// UUID text ids keep the schema portable across SQLite instances.

import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from '../services/auth.js';
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
    return this.db
      .prepare(`SELECT * FROM tenants ${where} ORDER BY created_at DESC`)
      .all(...params)
      .map((t) => this._decorate(t));
  }

  get(id) {
    if (!id) return null;
    const row = this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(String(id));
    return row ? this._decorate(row) : null;
  }

  // New tenants start PENDING_ACTIVATION so their first login must redeem a
  // product key before any ERP screen is reachable.
  //
  // Onboarding always provisions an owner login so the tenant has credentials
  // immediately:
  //   * a custom `password` (>= 6 chars) is used as-is -> no forced change, or
  //   * a one-time temporary password is generated (returned as `tempPassword`
  //     for the Control Tower to relay) and `requires_password_change = 1`, so
  //     the owner must set their own password on first login.
  create({
    companyName,
    ownerEmail,
    ownerUsername = null,
    password = null,
    status = 'PENDING_ACTIVATION',
    licenseKey = null,
    licenseExpiresAt = null,
    storage = null,
  }) {
    if (!companyName) throw new Error('COMPANY_NAME_REQUIRED');
    if (!ownerEmail) throw new Error('OWNER_EMAIL_REQUIRED');
    if (!VALID_STATUSES.has(status)) throw new Error('INVALID_STATUS');
    if (password !== null && String(password).length < 6) throw new Error('PASSWORD_TOO_SHORT');
    const login =
      ownerUsername != null && String(ownerUsername).trim()
        ? String(ownerUsername).trim().toLowerCase()
        : String(ownerEmail).split('@')[0].toLowerCase();
    if (!login || (login.length < 3 && ownerUsername != null && String(ownerUsername).trim())) {
      throw new Error('OWNER_USERNAME_TOO_SHORT');
    }
    // A derived login (email local-part) may be short, but it must exist.
    if (!login) throw new Error('OWNER_USERNAME_REQUIRED');
    const dupUsername = this.db.prepare('SELECT id FROM users WHERE username = ?').get(login);
    if (dupUsername) throw new Error('DUPLICATE_USERNAME: ' + login);
    const tempPassword = password ? null : randomBytes(4).toString('hex');
    // license key uniqueness is delegated to the shared product_keys table.
    const id = randomUUID();
    const s = normalizeStorage(storage);
    this.db
      .prepare(
        `INSERT INTO tenants (id, company_name, owner_email, status, license_key, license_expires_at,
        storage_kind, storage_path, storage_db, machine_id, environment_ready)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        companyName,
        ownerEmail,
        status,
        licenseKey ?? null,
        licenseExpiresAt ?? null,
        s.kind,
        s.path,
        s.db,
        s.machineId,
        s.environmentReady ? 1 : 0,
      );
    // Owner login row on the global users table (super-admin scope, scoped to
    // the tenant via tenant_id). One-time temporary passwords force a change.
    this.db
      .prepare(
        `INSERT INTO users (username, password_hash, full_name, role, requires_password_change, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(login, hashPassword(tempPassword || password), companyName, 'owner', tempPassword ? 1 : 0, id);
    const t = this.get(id);
    if (tempPassword) t.tempPassword = tempPassword;
    return t;
  }

  setStatus(id, status) {
    if (!VALID_STATUSES.has(status)) throw new Error('INVALID_STATUS');
    this.db.prepare(`UPDATE tenants SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?`).run(status, String(id));
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
    const base =
      t.license_expires_at && new Date(t.license_expires_at).getTime() > Date.now()
        ? new Date(t.license_expires_at)
        : new Date();
    base.setDate(base.getDate() + n);
    const expires = base.toISOString();
    this.db
      .prepare(`UPDATE tenants SET license_expires_at = ?, updated_at = datetime('now','localtime') WHERE id = ?`)
      .run(expires, String(id));
    // Extending a pending/lapsed tenant re-activates it.
    if (t.status === 'EXPIRED' || t.status === 'PENDING_KEY' || t.status === 'PENDING_ACTIVATION') {
      this.db
        .prepare(`UPDATE tenants SET status = 'ACTIVE', updated_at = datetime('now','localtime') WHERE id = ?`)
        .run(String(id));
    }
    return this.get(id);
  }

  update(id, fields) {
    const t = this.get(id);
    if (!t) return null;
    const sets = [];
    const params = [];
    if (fields.companyName !== undefined) {
      sets.push('company_name = ?');
      params.push(fields.companyName);
    }
    if (fields.ownerEmail !== undefined) {
      sets.push('owner_email = ?');
      params.push(fields.ownerEmail);
    }
    if (fields.status !== undefined) {
      if (!VALID_STATUSES.has(fields.status)) throw new Error('INVALID_STATUS');
      sets.push('status = ?');
      params.push(fields.status);
    }
    if (fields.storage !== undefined) {
      const s = normalizeStorage(fields.storage);
      sets.push('storage_kind = ?');
      params.push(s.kind);
      sets.push('storage_path = ?');
      params.push(s.path);
      sets.push('storage_db = ?');
      params.push(s.db);
      sets.push('machine_id = ?');
      params.push(s.machineId);
      sets.push('environment_ready = ?');
      params.push(s.environmentReady ? 1 : 0);
    }
    // An explicit machine_id (without the container) is enough to stamp the
    // environment that owns this tenant's data.
    if (fields.machineId !== undefined && fields.storage === undefined) {
      sets.push('machine_id = ?');
      params.push(fields.machineId);
    }
    const hasUserChanges =
      fields.owner_username !== undefined ||
      fields.new_password !== undefined ||
      fields.address !== undefined ||
      fields.telephone !== undefined ||
      fields.mobile !== undefined ||
      fields.trading_as !== undefined;
    if (!sets.length && !hasUserChanges) return t;
    if (sets.length) {
      sets.push("updated_at = datetime('now','localtime')");
      params.push(String(id));
      this.db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }

    // Owner user overrides (Control Tower credential management): change the
    // owner username and/or force a password reset without the current password.
    const owner = findOwner(this.db, String(id));
    if (owner && (fields.owner_username !== undefined || fields.new_password !== undefined)) {
      const uSets = [];
      const uVals = [];
      if (fields.owner_username !== undefined && String(fields.owner_username).trim()) {
        const name = String(fields.owner_username).trim();
        const dup = this.db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(name, owner.id);
        if (dup) throw new Error('DUPLICATE_USERNAME');
        uSets.push('username = ?');
        uVals.push(name);
      }
      if (fields.new_password !== undefined && String(fields.new_password)) {
        uSets.push('password_hash = ?');
        uVals.push(hashPassword(String(fields.new_password)));
        // An admin-forced reset must be followed by the owner setting their
        // own password on next login.
        uSets.push('requires_password_change = ?');
        uVals.push(1);
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
    const current =
      this.db.prepare('SELECT * FROM company_settings WHERE id = 1 AND tenant_id = ?').get(String(tenant)) || {};
    const next = {
      company_name: current.company_name || '',
      trading_as: current.trading_as || '',
      tagline: current.tagline || '',
      address: current.address || '',
      telephone: current.telephone || '',
      mobile: current.mobile || '',
      reg_number: current.reg_number || '',
      tin_number: current.tin_number || '',
      vat_number: current.vat_number || '',
      banking_details: current.banking_details || '[]',
    };
    for (const k of Object.keys(fields)) if (fields[k] !== undefined) next[k] = fields[k];
    this.db
      .prepare(
        `
      INSERT INTO company_settings (
        id, company_name, trading_as, tagline, address, telephone, mobile,
        reg_number, tin_number, vat_number, banking_details, tenant_id, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
      ON CONFLICT(id) DO UPDATE SET
        company_name = excluded.company_name, trading_as = excluded.trading_as,
        tagline = excluded.tagline, address = excluded.address,
        telephone = excluded.telephone, mobile = excluded.mobile,
        reg_number = excluded.reg_number, tin_number = excluded.tin_number,
        vat_number = excluded.vat_number, banking_details = excluded.banking_details,
        tenant_id = excluded.tenant_id, updated_at = datetime('now','localtime')
    `,
      )
      .run(
        next.company_name,
        next.trading_as,
        next.tagline,
        next.address,
        next.telephone,
        next.mobile,
        next.reg_number,
        next.tin_number,
        next.vat_number,
        next.banking_details,
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
      storage: {
        kind: t.storage_kind || null,
        path: t.storage_path || null,
        db: t.storage_db || null,
        machineId: t.machine_id || null,
        environmentReady: Number(t.environment_ready) === 1,
      },
    };
  }
}

// Tolerate a loose storage shape ({ kind, path, db, machineId, environmentReady }
// or its snake_case siblings) and always return a complete object.
function normalizeStorage(storage = null) {
  const src = storage || {};
  return {
    kind: src.kind ?? src.storage_kind ?? null,
    path: src.path ?? src.storage_path ?? null,
    db: src.db ?? src.storage_db ?? null,
    machineId: src.machineId ?? src.machine_id ?? null,
    environmentReady: Boolean(src.environmentReady ?? src.environment_ready ?? true),
  };
}
