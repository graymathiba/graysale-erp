import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { unauthorized, forbidden } from '../lib/errors.js';
import { tx } from '../db/database.js';

// Role -> permission matrix.
const PERMISSIONS = {
  owner: ['*'],
  manager: [
    'pos.sell', 'pos.refund', 'pos.layaway', 'pos.quote',
    'catalog.view', 'catalog.manage',
    'inventory.view', 'inventory.adjust',
    'customers.view', 'customers.manage',
    'suppliers.view', 'suppliers.manage',
    'purchasing.view', 'purchasing.manage',
    'invoicing.view', 'invoicing.manage',
    'accounting.view', 'accounting.post', 'accounting.reconcile',
    'reports.view', 'eod.view', 'eod.self', 'eod.run',
    'users.view', 'users.manage', 'users.delete', 'settings.manage',
  ],
  accountant: [
    'catalog.view', 'inventory.view',
    'customers.view', 'suppliers.view',
    'purchasing.view', 'invoicing.view',
    'accounting.view', 'accounting.post', 'accounting.reconcile',
    'reports.view', 'eod.view',
  ],
  cashier: [
    'pos.sell', 'pos.refund',
    'catalog.view', 'inventory.view',
    'customers.view', 'customers.manage',
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

const SESSION_TTL_HOURS = 12;

export class AuthService {
  constructor(db) {
    this.db = db;
  }

  addDefaultAdmin() {
    const has = this.db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get();
    if (!has) {
      this.db.prepare(
        'INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)'
      ).run('admin', hashPassword('admin123'), 'System Administrator', 'owner');
    }
  }

  ensureDefaultData() {
    this.addDefaultAdmin();
  }

  createUser({ username, password, fullName, role, locationId }) {
    const existing = this.db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) throw new Error(`DUPLICATE_USERNAME: ${username}`);
    if (!PERMISSIONS[role]) throw new Error(`INVALID_ROLE: ${role}`);
    const info = this.db.prepare(
      'INSERT INTO users (username, password_hash, full_name, role, location_id) VALUES (?, ?, ?, ?, ?)'
    ).run(username, hashPassword(password), fullName || username, role, locationId ?? null);
    return info.lastInsertRowid;
  }

  listUsers() {
    return this.db.prepare(
      'SELECT id, username, full_name, role, location_id, active, created_at FROM users ORDER BY id'
    ).all();
  }

  updateUser(id, fields) {
    const sets = [];
    const vals = [];
    if (fields.role != null) {
      if (!PERMISSIONS[fields.role]) throw new Error(`INVALID_ROLE: ${fields.role}`);
      sets.push('role = ?'); vals.push(fields.role);
    }
    if (fields.fullName != null) { sets.push('full_name = ?'); vals.push(fields.fullName); }
    if (fields.active != null) { sets.push('active = ?'); vals.push(fields.active ? 1 : 0); }
    if (fields.locationId !== undefined) { sets.push('location_id = ?'); vals.push(fields.locationId); }
    if (fields.password != null) { sets.push('password_hash = ?'); vals.push(hashPassword(fields.password)); }
    if (!sets.length) return;
    vals.push(Number(id));
    this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  // Soft-delete (deactivate): prevents login but preserves records/shift history.
  deactivateUser(id, actor) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
    if (!u) throw new Error('USER_NOT_FOUND');
    if (u.role === 'owner' && u.id !== actor?.id) throw new Error('CANNOT_DEACTIVATE_OWNER');
    this.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(Number(id));
    return this.db.prepare('SELECT id, username, full_name, role, active FROM users WHERE id = ?').get(Number(id));
  }

  reactivateUser(id, actor) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
    if (!u) throw new Error('USER_NOT_FOUND');
    this.db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(Number(id));
    return this.db.prepare('SELECT id, username, full_name, role, active FROM users WHERE id = ?').get(Number(id));
  }

  // Does this user have an OPEN shift with any recorded transactions / cash flow?
  // If so they cannot be permanently deleted (their session would orphan POS history).
  openShiftInUse(userId) {
    const shift = this.db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM orders o WHERE o.user_id = s.user_id
      AND o.created_at >= substr(replace(replace(s.opened_at, 'T', ' '), 'Z', ''), 1, 19)
      AND (s.closed_at IS NULL OR o.created_at < substr(replace(replace(s.closed_at, 'T', ' '), 'Z', ''), 1, 19))) AS txn
      FROM shifts s WHERE s.user_id = ? AND s.status = 'OPEN'`).get(Number(userId));
    return shift && shift.txn > 0 ? shift : null;
  }

  deleteUser(id, actor) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
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
      this.db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      return { ok: true, username: u.username };
    });
  }

  get(id) {
    return this.db.prepare('SELECT id, username, full_name, role, active FROM users WHERE id = ?').get(Number(id));
  }

  login({ username, password }) {
    const user = this.db.prepare(
      'SELECT * FROM users WHERE username = ? AND active = 1'
    ).get(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return { ok: false, error: 'INVALID_CREDENTIALS' };
    }
    const t = randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + SESSION_TTL_HOURS * 3600_000).toISOString();
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    this.db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(t, user.id, expires);
    this.audit(user.id, user.username, 'LOGIN', 'user', user.id, '');
    return { ok: true, token: t, user: this.publicUser(user) };
  }

  logout(token) {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  publicUser(u) {
    return { id: u.id, username: u.username, fullName: u.full_name, role: u.role, locationId: u.location_id };
  }

  userForToken(token) {
    if (!token) return null;
    const row = this.db.prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ? AND u.active = 1
    `).get(token, new Date().toISOString());
    return row ? this.publicUser(row) : null;
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
    this.db.prepare(
      'INSERT INTO audit_log (user_id, username, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId ?? null, username ?? null, action, entityType ?? null, entityId ?? null, String(detail ?? ''));
  }

  listAudit(limit = 100) {
    return this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(Math.min(limit, 1000));
  }
}

export { PERMISSIONS };