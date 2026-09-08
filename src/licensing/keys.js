// Product activation-key service for the Control Tower. Generates single or
// bulk keys in the GS-XXXX-XXXX-XXXX format, tracks their lifecycle across
// UNUSED → REDEEMED / REVOKED, and binds redeemed keys to tenants.

import { uuid } from '../db/database.js';

const PLAN_DURATIONS = { MONTHLY: 30, QUARTERLY: 90, ANNUAL: 365, LIFETIME: 36500 };
const VALID_PLANS = new Set(Object.keys(PLAN_DURATIONS));

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous I/O/0/1
const STATUS_REDEEMED = 'REDEEMED';

export class ProductKeysService {
  constructor(db) {
    this.db = db;
  }

  // Generate 1..n keys. `planType` is one of MONTHLY/ANNUAL/LIFETIME.
  generate({ planType, count = 1, generatedBy }) {
    if (!VALID_PLANS.has(planType)) throw new Error('INVALID_PLAN_TYPE');
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error('INVALID_COUNT');

    const durationDays = PLAN_DURATIONS[planType];
    const out = [];
    const insert = this.db.prepare(
      `INSERT INTO product_keys (id, key_code, plan_type, duration_days, is_used, status, generated_by)
       VALUES (?, ?, ?, ?, 0, 'UNUSED', ?)`
    );
    let attempts = 0;
    while (out.length < n && attempts < n * 20) {
      attempts++;
      const code = this._newCode();
      try {
        insert.run(uuid(), code, planType, durationDays, generatedBy ?? null);
        out.push({ keyCode: code, planType, durationDays, status: 'UNUSED' });
      } catch (_) {
        // unique collision — retry with a fresh code
      }
    }
    if (out.length < n) throw new Error('KEY_GENERATION_FAILED');
    return { count: out.length, keys: out };
  }

  list({ status = null, search = '' } = {}) {
    const conds = [];
    const params = [];
    if (status) {
      conds.push('pk.status = ?');
      params.push(status);
    }
    if (search) {
      conds.push('LOWER(key_code) LIKE ?');
      params.push(`%${String(search).toLowerCase()}%`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT pk.*, t.company_name AS tenant_name
       FROM product_keys pk
       LEFT JOIN tenants t ON t.id = pk.assigned_tenant_id
       ${where}
       ORDER BY pk.created_at DESC`
    ).all(...params);
  }

  getByCode(keyCode) {
    if (!keyCode) return null;
    return this.db.prepare(
      `SELECT pk.*, t.company_name AS tenant_name
       FROM product_keys pk
       LEFT JOIN tenants t ON t.id = pk.assigned_tenant_id
       WHERE pk.key_code = ?`
    ).get(String(keyCode).trim().toUpperCase()) || null;
  }

  // Redeem a key for a tenant: binds tenant, marks used, activates the tenant.
  redeem(keyCode, tenantId) {
    const key = this.getByCode(keyCode);
    if (!key) return { ok: false, code: 'INVALID_KEY', message: 'Activation key not recognized.' };
    if (key.status === 'REVOKED') return { ok: false, code: 'KEY_REVOKED', message: 'This activation key has been revoked. Please contact support.' };
    if (key.status === STATUS_REDEEMED) return { ok: false, code: 'KEY_ALREADY_USED', message: 'This activation key has already been redeemed.' };

    const tenant = this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(String(tenantId));
    if (!tenant) return { ok: false, code: 'TENANT_NOT_FOUND', message: 'Unknown tenant.' };

    const db = this.db;
    db.exec('BEGIN');
    try {
      db.prepare(
        `UPDATE product_keys SET is_used = 1, status = ?, assigned_tenant_id = ?, used_at = datetime('now')
         WHERE id = ?`
      ).run(STATUS_REDEEMED, tenant.id, key.id);

      const base = key.planType === 'LIFETIME'
        ? null
        : new Date(Date.now() + key.duration_days * 864e5).toISOString();

      db.prepare(
        `UPDATE tenants SET license_key = ?, license_expires_at = ?, status = 'ACTIVE', updated_at = datetime('now')
         WHERE id = ?`
      ).run(key.key_code, base, tenant.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { ok: true, tenant: this._tenantById(tenantId) };
  }

  _tenantById(id) {
    const t = this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(String(id));
    if (!t) return null;
    const users = this.db.prepare('SELECT COUNT(*) AS c FROM users WHERE tenant_id = ?').get(String(id));
    return { ...t, activeUsers: users?.c ?? 0, isExpired: Boolean(t.license_expires_at) && new Date(t.license_expires_at).getTime() < Date.now() };
  }

  revoke(id) {
    const row = this.db.prepare('SELECT * FROM product_keys WHERE id = ?').get(String(id));
    if (!row) return null;
    this.db.prepare("UPDATE product_keys SET status = 'REVOKED' WHERE id = ?").run(String(id));
    // Unassign the tenant's key so they fall into PENDING_KEY state.
    if (row.assigned_tenant_id) {
      this.db.prepare(
        `UPDATE tenants SET status = 'PENDING_KEY', license_key = NULL WHERE id = ? AND license_key = ?`
      ).run(row.assigned_tenant_id, row.key_code);
    }
    return this.getByCode(row.key_code);
  }

  // Aggregate inventory: totals generated vs redeemed/used, plus a fleet view.
  metrics() {
    const byStatus = this.db.prepare(
      'SELECT status, COUNT(*) AS c FROM product_keys GROUP BY status'
    ).all();
    const total = this.db.prepare('SELECT COUNT(*) AS c FROM product_keys').get().c;
    const used = this.db.prepare("SELECT COUNT(*) AS c FROM product_keys WHERE is_used = 1").get().c;
    const statusMap = Object.fromEntries(byStatus.map((r) => [r.status, r.c]));
    return {
      totalGenerated: total,
      totalRedeemed: used,
      unused: statusMap.UNUSED || 0,
      redeemed: statusMap[STATUS_REDEEMED] || 0,
      revoked: statusMap.REVOKED || 0,
    };
  }

  _newCode() {
    const seg = () => {
      let s = '';
      for (let i = 0; i < 4; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
      return s;
    };
    return `GS-${seg()}-${seg()}-${seg()}`;
  }
}
