// Authentication: scrypt password hashing, DB-backed sessions,
// role-based authorization, rate limiting. No external dependencies.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { currentTenant } from './db/database.js';

export const ROLES = Object.freeze({
  CASHIER: 'cashier',
  MANAGER: 'manager',
  ADMIN: 'admin',
});

// Role hierarchy. Each role can perform its own level and everything below it.
const ROLE_RANK = Object.freeze({ cashier: 1, manager: 2, admin: 3 });

// Capability -> minimum role rank required.
const CAP_RANK = Object.freeze({
  'pos.checkout': 1,
  'sales.view': 1,
  'inventory.view': 1,
  'products.view': 1,
  'customers.view': 1,
  'pos.sell': 1,
  'pos.refund': 1,
  'eod.self': 1,
  'catalog.view': 1,
  'customers.manage': 1,

  'inventory.adjust': 2,
  'sales.void': 2,
  'products.manage': 2,
  'backup.run': 2,
  'accounting.view': 2,
  'reports.view': 2,
  'pos.layaway': 2,
  'pos.quote': 2,
  'catalog.manage': 2,
  'suppliers.view': 2,
  'suppliers.manage': 2,
  'purchasing.view': 2,
  'purchasing.manage': 2,
  'invoicing.view': 2,
  'invoicing.manage': 2,
  'accounting.post': 2,
  'accounting.reconcile': 2,
  'eod.view': 2,
  'eod.run': 2,
  'users.view': 2,
  'settings.manage': 2,

  'users.manage': 3,
  'agents.run': 1,
  'audit.view': 3,
});

const SALT_LEN = 16;
const KEY_LEN = 64;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

export function hashPassword(password) {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

export function can(role, capability) {
  const needed = CAP_RANK[capability];
  if (needed == null) return false;
  return (ROLE_RANK[role] ?? 0) >= needed;
}

export function roleRank(role) {
  return ROLE_RANK[role] ?? 0;
}

export { CAP_RANK, ROLE_RANK };

export function validatePassword(password) {
  if (typeof password !== 'string') return false;
  if (password.length < 8) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  return true;
}

class AuthService {
  constructor(store) {
    this.store = store;
    this.sessionTtlMs = process.env.SESSION_TTL_MS ? Number(process.env.SESSION_TTL_MS) : 12 * 3600 * 1000;
    this._failedAttempts = new Map(); // username -> { count, firstAt }
  }

  login({ username, password }) {
    if (this._isRateLimited(username)) {
      this.audit(null, username || 'unknown', 'LOGIN_RATE_LIMITED', null, null, 'Too many failed attempts');
      return { ok: false, error: 'RATE_LIMITED' };
    }

    const user = this.store.db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      this._recordFailure(username);
      this.audit(user?.id || null, username || 'unknown', 'LOGIN_FAILED', null, null, 'Invalid credentials');
      return { ok: false, error: 'INVALID_CREDENTIALS' };
    }

    this._clearFailures(username);

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + this.sessionTtlMs).toISOString();
    try {
      this.store.db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expiresAt);
    } catch (_) {
      return { ok: false, error: 'SESSION_STORAGE_FAILED' };
    }

    this.audit(user.id, user.username, 'LOGIN', 'user', user.id, 'Login');
    return { ok: true, token, user: this.publicUser(user) };
  }

  logout(token) {
    if (!token) return;
    try {
      this.store.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    } catch (_) {}
  }

  userForToken(token) {
    if (!token) return null;
    try {
      const sess = this.store.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
      if (!sess) return null;
      if (new Date(sess.expires_at).getTime() < Date.now()) {
        this.store.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
        return null;
      }
      return this.store.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(sess.user_id) || null;
    } catch (_) {
      return null;
    }
  }

  publicUser(u) {
    const caps = this.listUserCapabilities(u.id);
    return { id: u.id, username: u.username, fullName: u.full_name, role: u.role, active: u.active, isSuperAdmin: !!u.is_super_admin, capabilities: caps };
  }

  // Super admins live outside normal tenant boundaries. Only accounts carrying
  // the global is_super_admin flag may reach the Control Tower `/admin/*` APIs.
  isSuperAdmin(user) {
    return !!user && !!(user.is_super_admin || user.isSuperAdmin);
  }

  requireSuperAdmin(user) {
    if (!this.isSuperAdmin(user)) return false;
    return true;
  }

  requireCapability(user, capability) {
    if (!user) return false;
    if (can(user.role, capability)) return true;
    const grant = this.store.db.prepare(
      'SELECT 1 FROM user_capabilities WHERE user_id = ? AND capability = ?'
    ).get(user.id, capability);
    return !!grant;
  }

  grantCapability(granterId, userId, capability) {
    if (!CAP_RANK[capability]) {
      return { ok: false, error: 'UNKNOWN_CAPABILITY' };
    }
    const granter = this.store.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(granterId);
    if (!granter) return { ok: false, error: 'GRANTER_NOT_FOUND' };
    if (!can(granter.role, capability)) {
      return { ok: false, error: 'GRANTER_LACKS_CAPABILITY' };
    }
    const target = this.store.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId);
    if (!target) return { ok: false, error: 'USER_NOT_FOUND' };
    if (can(target.role, capability)) {
      return { ok: false, error: 'ALREADY_HAS_ROLE_CAPABILITY' };
    }

    try {
      this.store.db.prepare(
        'INSERT INTO user_capabilities (user_id, capability, granted_by) VALUES (?, ?, ?)'
      ).run(userId, capability, granterId);
    } catch (e) {
      if (e.message?.includes('UNIQUE')) {
        return { ok: false, error: 'ALREADY_GRANTED' };
      }
      throw e;
    }

    this.audit(granterId, granter.username, 'CAPABILITY_GRANT', 'user', userId, capability);
    return { ok: true, userId, capability, grantedBy: granterId };
  }

  revokeCapability(granterId, userId, capability) {
    if (!CAP_RANK[capability]) {
      return { ok: false, error: 'UNKNOWN_CAPABILITY' };
    }
    const granter = this.store.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(granterId);
    if (!granter) return { ok: false, error: 'GRANTER_NOT_FOUND' };
    if (!can(granter.role, capability)) {
      return { ok: false, error: 'GRANTER_LACKS_CAPABILITY' };
    }
    const target = this.store.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId);
    if (!target) return { ok: false, error: 'USER_NOT_FOUND' };

    const result = this.store.db.prepare(
      'DELETE FROM user_capabilities WHERE user_id = ? AND capability = ?'
    ).run(userId, capability);

    if (result.changes === 0) {
      return { ok: false, error: 'NOT_GRANTED' };
    }

    this.audit(granterId, granter.username, 'CAPABILITY_REVOKE', 'user', userId, capability);
    return { ok: true, userId, capability };
  }

  listUserCapabilities(userId) {
    const user = this.store.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return [];

    const roleCaps = Object.entries(CAP_RANK)
      .filter(([_, minRank]) => (ROLE_RANK[user.role] ?? 0) >= minRank)
      .map(([cap]) => ({ capability: cap, source: 'role' }));

    const grants = this.store.db.prepare(
      'SELECT uc.capability, uc.granted_by, u.username AS granter_name, uc.created_at FROM user_capabilities uc LEFT JOIN users u ON u.id = uc.granted_by WHERE uc.user_id = ?'
    ).all(userId).map(g => ({ capability: g.capability, source: 'grant', grantedBy: g.granted_by, granterName: g.granter_name, createdAt: g.created_at }));

    return [...roleCaps, ...grants];
  }

  audit(userId, username, action, entity, entityId, detail) {
    try {
      this.store.db.prepare(
        'INSERT INTO audit_log (user_id, username, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(userId, username, action, entity, entityId, detail);
    } catch (e) {
      // never let audit failures break the primary action
    }
  }

  listAudit(limit = 100) {
    return this.store.db.prepare(
      'SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?'
    ).all(limit);
  }

  listUsers() {
    return this.store.db.prepare(
      'SELECT id, username, full_name, role, active, is_super_admin, created_at FROM users ORDER BY username'
    ).all();
  }

  ensureDefaultAdmin({ username, password, fullName } = {}) {
    const db = this.store.db;
    const name = username || 'admin';
    const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    if (count === 0) {
      const pw = password || 'Admin123';
      if (!validatePassword(pw)) {
        throw new Error('Default admin password does not meet complexity requirements');
      }
      const tenant = currentTenant(db);
      // The bootstrapped account is the platform administrator: it carries the
      // global is_super_admin flag so the Control Tower is reachable out of the box.
      db.prepare(
        'INSERT INTO users (username, password_hash, full_name, role, tenant_id, is_super_admin) VALUES (?, ?, ?, ?, ?, 1)'
      ).run(name, hashPassword(pw), fullName || 'Administrator', ROLES.ADMIN, tenant ? tenant.id : null);
      return true;
    }

    // Idempotent upgrade for installs that predate the super-admin flag: the
    // bootstrapped platform account always gets Control Tower access.
    db.prepare('UPDATE users SET is_super_admin = 1 WHERE username = ? AND is_super_admin = 0').run(name);
    return false;
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
    this._failedAttempts.delete(username);
  }
}

export { AuthService };
