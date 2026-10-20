import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { unauthorized, forbidden } from '../lib/errors.js';
import { tx } from '../db/database.js';
import { resolveTenantId } from '../lib/tenant.js';
import { config } from '../config.js';

// Sessions are stored as sha256 digests: a stolen database dump never yields
// usable bearer tokens. The raw token only ever exists in the client.
const hashToken = (raw) => createHash('sha256').update(String(raw)).digest('hex');

// Role -> permission matrix.
const PERMISSIONS = {
  owner: ['*'],
  manager: [
    'pos.sell',
    'pos.refund',
    'pos.layaway',
    'pos.quote',
    'catalog.view',
    'catalog.manage',
    'inventory.view',
    'inventory.adjust',
    'customers.view',
    'customers.manage',
    'suppliers.view',
    'suppliers.manage',
    'purchasing.view',
    'purchasing.manage',
    'invoicing.view',
    'invoicing.manage',
    'accounting.view',
    'accounting.post',
    'accounting.reconcile',
    'reports.view',
    'eod.view',
    'eod.self',
    'eod.run',
    'users.view',
    'users.manage',
    'users.delete',
    'settings.manage',
  ],
  accountant: [
    'catalog.view',
    'inventory.view',
    'customers.view',
    'suppliers.view',
    'purchasing.view',
    'invoicing.view',
    'accounting.view',
    'accounting.post',
    'accounting.reconcile',
    'reports.view',
    'eod.view',
  ],
  cashier: [
    'pos.sell',
    'pos.refund',
    'catalog.view',
    'inventory.view',
    'customers.view',
    'customers.manage',
    'eod.self',
  ],
};

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password || ''), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes('$')) return false;
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const hash = scryptSync(String(password || ''), Buffer.from(saltHex, 'hex'), 64);
  return timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

const SESSION_TTL_MS = config.sessionTtlMs;

// Brute-force guard: after RATE_LIMIT_MAX failures for one username inside
// RATE_LIMIT_WINDOW_MS, further attempts are refused until the window rolls.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

export class AuthService {
  constructor(db) {
    this.db = db;
    this._failedAttempts = new Map(); // username -> { count, firstAt }
  }

  addDefaultAdmin() {
    const tenantId = resolveTenantId(this.db);
    const existing = this.db
      .prepare('SELECT id, username, is_super_admin FROM users WHERE username = ? OR role = ? ORDER BY id LIMIT 1')
      .get('admin', 'owner');
    if (!existing) {
      // The bootstrapped account is the platform administrator: it carries the
      // global is_super_admin flag so the Control Tower is reachable out of the box.
      // The default password is publicly known, so first login MUST rotate it.
      this.db
        .prepare(
          'INSERT INTO users (username, password_hash, full_name, role, tenant_id, is_super_admin, requires_password_change) VALUES (?, ?, ?, ?, ?, 1, 1)',
        )
        .run('admin', hashPassword('admin123'), 'System Administrator', 'owner', tenantId);
      return;
    }
    // Idempotent upgrade for installs that predate the super-admin flag: the
    // bootstrapped platform account always gets Control Tower access.
    if (existing.username === 'admin' && !existing.is_super_admin) {
      this.db.prepare('UPDATE users SET is_super_admin = 1 WHERE id = ?').run(existing.id);
    }
  }

  ensureDefaultData() {
    this.addDefaultAdmin();
  }

  createUser({ username, password, fullName, role, locationId, tenantId, actor } = {}) {
    const tenant = resolveTenantId(this.db, tenantId);
    const existing = this.db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) throw new Error(`DUPLICATE_USERNAME: ${username}`);
    if (!PERMISSIONS[role]) throw new Error(`INVALID_ROLE: ${role}`);
    // Only the platform administrator may mint owner accounts; managers and
    // accountants must not self-escalate. Direct onboarding calls (Control Tower,
    // license redemption) pass no actor and remain allowed.
    if (role === 'owner' && actor && !this.isSuperAdmin(actor)) throw forbidden('OWNER_CREATE_DENIED');
    const info = this.db
      .prepare(
        'INSERT INTO users (username, password_hash, full_name, role, location_id, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(username, hashPassword(password), fullName || username, role, locationId ?? null, tenant);
    return info.lastInsertRowid;
  }

  // Force-set password (self-service first-time password change).
  // `keepRawToken` is the caller's own session: it survives the reset while
  // every other device signed in as this user is signed out.
  setPassword(tokenOrUserId, newPassword, keepRawToken = null) {
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(tokenOrUserId));
    if (!user) throw new Error('USER_NOT_FOUND');
    if (!newPassword || String(newPassword).length < 6) throw new Error('PASSWORD_TOO_SHORT');
    this.db
      .prepare('UPDATE users SET password_hash = ?, requires_password_change = 0 WHERE id = ?')
      .run(hashPassword(newPassword), user.id);
    if (keepRawToken) {
      // Match both the digest and (on pre-upgrade installs) the raw value so
      // the caller's own session always survives the reset.
      this.db
        .prepare('DELETE FROM sessions WHERE user_id = ? AND token NOT IN (?, ?)')
        .run(user.id, hashToken(keepRawToken), String(keepRawToken));
    } else {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    }
    return this.get(user.id, user.tenant_id);
  }

  // Self-service tenant registration: creates tenant + owner user + default
  // data in one transaction. Returns { token, user, tenant } so the caller
  // is immediately signed in.
  registerTenant({ companyName, username, email, password }) {
    if (!companyName || !companyName.trim()) throw new Error('COMPANY_NAME_REQUIRED');
    if (!username || !username.trim()) throw new Error('USERNAME_REQUIRED');
    if (!password || String(password).length < 6) throw new Error('PASSWORD_TOO_SHORT');
    const trimmedUser = String(username).trim().toLowerCase();

    const existing = this.db.prepare('SELECT id FROM users WHERE username = ?').get(trimmedUser);
    if (existing) throw new Error('DUPLICATE_USERNAME: ' + trimmedUser);

    const tenantId = randomUUID();
    const normalizedEmail = email ? String(email).trim().toLowerCase() : '';

    return tx(this.db, () => {
      // Create tenant. Self-registered companies start PENDING_ACTIVATION so
      // the owner is routed to /activate-license to redeem a real product key.
      this.db
        .prepare('INSERT INTO tenants (id, company_name, owner_email, status, license_key) VALUES (?, ?, ?, ?, ?)')
        .run(tenantId, companyName.trim(), normalizedEmail, 'PENDING_ACTIVATION', null);

      // Create owner user (no password change required — they just chose it)
      const info = this.db
        .prepare(
          'INSERT INTO users (username, password_hash, full_name, role, requires_password_change, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(trimmedUser, hashPassword(password), companyName.trim(), 'owner', 0, tenantId);

      const origUser = this.db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

      const t = randomBytes(24).toString('hex');
      const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      this.db
        .prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
        .run(hashToken(t), origUser.id, expires);
      this.audit(origUser.id, trimmedUser, 'REGISTER', 'tenant', tenantId, companyName.trim());

      return {
        ok: true,
        token: t,
        user: this.publicUser(origUser),
        tenant: this.tenantForUser(origUser),
      };
    });
  }

  listUsers(tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    return this.db
      .prepare(
        'SELECT id, username, full_name, role, location_id, active, tenant_id, created_at FROM users WHERE tenant_id = ? ORDER BY id',
      )
      .all(tenant);
  }

  updateUser(id, fields, tenantId, actor = null) {
    const tenant = resolveTenantId(this.db, tenantId);
    const target = this.db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(Number(id), tenant);
    if (!target) throw new Error('USER_NOT_FOUND');

    // Role lifetime guards: only the platform administrator may grant the owner
    // role, and no one (short of the owner themself / superadmin) may strip it.
    if (fields.role != null && fields.role !== target.role) {
      if (!PERMISSIONS[fields.role]) throw new Error(`INVALID_ROLE: ${fields.role}`);
      const superOk = this.isSuperAdmin(actor);
      if (fields.role === 'owner' && !superOk) throw forbidden('OWNER_ROLE_DENIED');
      if (target.role === 'owner' && !superOk && (!actor || actor.id !== target.id))
        throw forbidden('OWNER_ACCOUNT_LOCKED');
    }
    if (
      fields.active === false &&
      target.role === 'owner' &&
      !this.isSuperAdmin(actor) &&
      (!actor || actor.id !== target.id)
    ) {
      throw forbidden('CANNOT_DEACTIVATE_OWNER');
    }

    const sets = [];
    const vals = [];
    if (fields.role != null) {
      sets.push('role = ?');
      vals.push(fields.role);
    }
    if (fields.fullName != null) {
      sets.push('full_name = ?');
      vals.push(fields.fullName);
    }
    if (fields.active != null) {
      sets.push('active = ?');
      vals.push(fields.active ? 1 : 0);
    }
    if (fields.locationId !== undefined) {
      sets.push('location_id = ?');
      vals.push(fields.locationId);
    }
    if (fields.password != null) {
      sets.push('password_hash = ?');
      vals.push(hashPassword(fields.password));
    }
    if (!sets.length) return;
    vals.push(Number(id), tenant);
    this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...vals);
    // A password write invalidates every existing session for that user.
    if (fields.password != null) {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    }
  }

  // Soft-delete (deactivate): prevents login but preserves records/shift history.
  deactivateUser(id, actor, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const u = this.db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(Number(id), tenant);
    if (!u) throw new Error('USER_NOT_FOUND');
    if (u.role === 'owner' && u.id !== actor?.id) throw new Error('CANNOT_DEACTIVATE_OWNER');
    this.db.prepare('UPDATE users SET active = 0 WHERE id = ? AND tenant_id = ?').run(Number(id), tenant);
    return this.db.prepare('SELECT id, username, full_name, role, active FROM users WHERE id = ?').get(Number(id));
  }

  reactivateUser(id, actor, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const u = this.db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(Number(id), tenant);
    if (!u) throw new Error('USER_NOT_FOUND');
    this.db.prepare('UPDATE users SET active = 1 WHERE id = ? AND tenant_id = ?').run(Number(id), tenant);
    return this.db.prepare('SELECT id, username, full_name, role, active FROM users WHERE id = ?').get(Number(id));
  }

  // Does this user have an OPEN shift with any recorded transactions / cash flow?
  // If so they cannot be permanently deleted (their session would orphan POS history).
  openShiftInUse(userId) {
    const shift = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM orders o WHERE o.user_id = s.user_id
      AND o.created_at >= substr(replace(replace(s.opened_at, 'T', ' '), 'Z', ''), 1, 19)
      AND (s.closed_at IS NULL OR o.created_at < substr(replace(replace(s.closed_at, 'T', ' '), 'Z', ''), 1, 19))) AS txn
      FROM shifts s WHERE s.user_id = ? AND s.status = 'OPEN'`,
      )
      .get(Number(userId));
    return shift && shift.txn > 0 ? shift : null;
  }

  deleteUser(id, actor, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const u = this.db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(Number(id), tenant);
    if (!u) throw new Error('USER_NOT_FOUND');
    if (u.role === 'owner' && u.id !== actor?.id) throw new Error('CANNOT_DELETE_OWNER');
    // Never delete the currently signed-in owner.
    if (actor && actor.id === u.id) throw new Error('CANNOT_DELETE_SELF');
    const inUse = this.openShiftInUse(id);
    if (inUse) throw new Error('USER_HAS_OPEN_SHIFT');
    return tx(this.db, () => {
      // Foreign keys on orders.user_id, audit_log.user_id etc. are NOT cascade-deleted,
      // so null them out to preserve history before removing the user.
      this.db.prepare('UPDATE orders SET user_id = NULL WHERE user_id = ?').run(u.id);
      this.db.prepare('UPDATE audit_log SET user_id = NULL WHERE user_id = ?').run(u.id);
      this.db.prepare('UPDATE shifts SET user_id = NULL WHERE user_id = ?').run(u.id);
      this.db.prepare('UPDATE stock_movements SET user_id = NULL WHERE user_id = ?').run(u.id);
      this.db.prepare('UPDATE goods_receipts SET user_id = NULL WHERE user_id = ?').run(u.id);
      this.db.prepare('UPDATE payments SET user_id = NULL WHERE user_id = ?').run(u.id);
      this.db.prepare('UPDATE journal_entries SET user_id = NULL WHERE user_id = ?').run(u.id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      this.db.prepare('DELETE FROM users WHERE id = ? AND tenant_id = ?').run(u.id, tenant);
      return { ok: true, username: u.username };
    });
  }

  get(id, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    return this.db
      .prepare('SELECT id, username, full_name, role, active, tenant_id FROM users WHERE id = ? AND tenant_id = ?')
      .get(Number(id), tenant);
  }

  login({ username, password }) {
    if (this._isRateLimited(username)) {
      this.audit(null, username || 'unknown', 'LOGIN_RATE_LIMITED', 'user', null, 'Too many failed attempts');
      return { ok: false, error: 'RATE_LIMITED' };
    }
    const user = this.db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      this._recordFailure(username);
      this.audit(
        user?.id ?? null,
        username || 'unknown',
        'LOGIN_FAILED',
        'user',
        user?.id ?? null,
        'Invalid credentials',
      );
      return { ok: false, error: 'INVALID_CREDENTIALS' };
    }
    this._clearFailures(username);
    // Backfill tenant binding for legacy accounts created pre-v8.
    if (!user.tenant_id) {
      user.tenant_id = resolveTenantId(this.db);
      this.db.prepare('UPDATE users SET tenant_id = ? WHERE id = ?').run(user.tenant_id, user.id);
    }
    const t = randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    // Single active session per user: a fresh login evicts every prior token.
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    this.db
      .prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(t), user.id, expires);
    this.audit(user.id, user.username, 'LOGIN', 'user', user.id, '');
    return {
      ok: true,
      token: t,
      user: this.publicUser(user),
      tenant: this.tenantForUser(user),
      requiresPasswordChange: !!user.requires_password_change,
    };
  }

  logout(token) {
    if (!token) return;
    this.db.prepare('DELETE FROM sessions WHERE token IN (?, ?)').run(hashToken(token), String(token));
  }

  publicUser(u) {
    return {
      id: u.id,
      username: u.username,
      fullName: u.full_name,
      role: u.role,
      locationId: u.location_id,
      isSuperAdmin: !!u.is_super_admin,
      tenantId: u.tenant_id || null,
    };
  }

  tenantForUser(user) {
    if (!user) return null;
    const row = this.db
      .prepare(
        'SELECT id, company_name, owner_email, status, license_key, license_expires_at FROM tenants WHERE id = ?',
      )
      .get(user.tenant_id || user.tenantId || resolveTenantId(this.db));
    if (!row) return null;
    return { ...row, needsActivation: !!(row.status === 'PENDING_KEY' || row.status === 'PENDING_ACTIVATION') };
  }

  isSuperAdmin(user) {
    return !!user && !!(user.is_super_admin || user.isSuperAdmin);
  }

  // Strict Control Tower gate used by the super-admin route group.
  requireSuperAdmin(user) {
    if (!this.isSuperAdmin(user)) throw forbidden();
    return user;
  }

  userForToken(token) {
    if (!token) return null;
    const now = new Date().toISOString();
    const select = `
      SELECT u.*, s.last_seen_at AS session_last_seen
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ? AND u.active = 1
    `;
    let row = this.db.prepare(select).get(hashToken(token), now);
    if (!row) {
      // Sessions created before token hashing stored the raw value. Upgrade
      // such a row to its digest in place so existing installs stay signed in.
      const legacy = this.db.prepare(select).get(String(token), now);
      if (legacy) {
        this.db.prepare('UPDATE sessions SET token = ? WHERE token = ?').run(hashToken(token), String(token));
        row = legacy;
      }
    }
    if (row) this._touchSession(hashToken(token), row.session_last_seen);
    return row ? this.publicUser(row) : null;
  }

  // Presence for /superadmin/connected: stamp last_seen_at at most once per
  // minute per session so a busy till does not turn every request into a write.
  _touchSession(tokenHash, lastSeenRaw) {
    const last = Number(lastSeenRaw) || 0;
    if (Date.now() - last < 60_000) return;
    try {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?').run(Date.now(), tokenHash);
    } catch {
      /* pre-v13 schema or closed handle: presence is best-effort */
    }
  }

  hasPermission(user, capability) {
    if (!user) return false;
    const perms = PERMISSIONS[user.role];
    if (!perms) return false;
    if (perms.includes('*')) return true;
    if (perms.includes(capability)) return true;
    return false;
  }

  require(user, capability) {
    if (!user) throw unauthorized();
    if (!this.hasPermission(user, capability)) throw forbidden();
    return user;
  }

  audit(userId, username, action, entityType, entityId, detail) {
    this.db
      .prepare(
        'INSERT INTO audit_log (user_id, username, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(userId ?? null, username ?? null, action, entityType ?? null, entityId ?? null, String(detail ?? ''));
  }

  listAudit(limit = 100) {
    return this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(Math.min(limit, 1000));
  }

  _isRateLimited(username) {
    if (!username) return false;
    const entry = this._failedAttempts.get(username);
    if (!entry) return false;
    if (Date.now() - entry.firstAt > RATE_LIMIT_WINDOW_MS) {
      this._failedAttempts.delete(username);
      return false;
    }
    return entry.count >= RATE_LIMIT_MAX;
  }

  _recordFailure(username) {
    if (!username) return;
    const existing = this._failedAttempts.get(username);
    if (existing && Date.now() - existing.firstAt <= RATE_LIMIT_WINDOW_MS) {
      existing.count++;
    } else {
      this._failedAttempts.set(username, { count: 1, firstAt: Date.now() });
    }
  }

  _clearFailures(username) {
    if (!username) return;
    this._failedAttempts.delete(username);
  }
}

export { PERMISSIONS };
