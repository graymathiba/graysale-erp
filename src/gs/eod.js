// End-of-day cash reconciliation service ported onto shared shifts table.
// Cash-flow sources read from gs_orders + payments.

import { tx, nextDoc } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';

// SQLite datetime('now') prints 'YYYY-MM-DD HH:MM:SS'; normalize ISO for range compares.
const sqlUtc = (iso) => (iso || '').replace('T', ' ').replace(/\.\d+Z?$/, '');

class EodService {
  constructor(db) {
    this.db = db;
  }

  open({ user, locationId, openingCashCents }) {
    const open = this.db.prepare("SELECT id FROM shifts WHERE user_id = ? AND status = 'OPEN'").get(user?.id);
    if (open) throw conflict('SHIFT_ALREADY_OPEN');
    return tx(this.db, (db) => {
      const docNo = nextDoc(db, 'SHIFT');
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO shifts (doc_no, user_id, location_id, opening_cash_cents, status, opened_at)
        VALUES (?, ?, ?, ?, 'OPEN', ?)
      `).run(docNo, user?.id ?? null, locationId ?? user?.locationId ?? null, Math.round(Number(openingCashCents ?? 0)), new Date().toISOString());
      return this.get(lastInsertRowid);
    });
  }

  _cashFlows(shift) {
    const from = sqlUtc(shift.opened_at || '0000-01-01 00:00:00');
    const to = sqlUtc(shift.closed_at || new Date(Date.now() + 60_000).toISOString());
    const fromDay = from.slice(0, 10);
    const toDay = to.slice(0, 10);

    const cashFlow = this.db.prepare(`
      SELECT COALESCE(SUM(cash_in), 0) - COALESCE(SUM(cash_out), 0) AS net FROM (
        SELECT json_extract(o.meta, '$.applied_cash') AS cash_in, 0 AS cash_out
        FROM gs_orders o WHERE o.type = 'SALE' AND o.status = 'PAID'
          AND o.created_at >= ? AND o.created_at < ?
        UNION ALL
        SELECT json_extract(o.meta, '$.payments.CASH') AS cash_in, 0 AS cash_out
        FROM gs_orders o WHERE o.type = 'LAYAWAY' AND o.status IN ('OPEN','COMPLETED')
          AND o.created_at >= ? AND o.created_at < ?
        UNION ALL
        SELECT 0 AS cash_in, json_extract(o.meta, '$.return_cash') AS cash_out
        FROM gs_orders o WHERE o.type = 'REFUND' AND o.status = 'PAID'
          AND o.created_at >= ? AND o.created_at < ?
        UNION ALL
        SELECT p.amount_cents AS cash_in, 0 AS cash_out
        FROM payments p WHERE p.kind = 'RECEIPT' AND p.method = 'CASH' AND p.voided = 0
          AND p.date >= ? AND p.date <= ?
        UNION ALL
        SELECT 0 AS cash_in, p.amount_cents AS cash_out
        FROM payments p WHERE p.kind = 'EXPENSE' AND p.method = 'CASH' AND p.voided = 0
          AND p.date >= ? AND p.date <= ?
      )
    `);
    return cashFlow.get(from, to, from, to, from, to, fromDay, toDay, fromDay, toDay)?.net ?? 0;
  }

  close({ shiftId, countedCashCents, note, user }) {
    const shift = this.get(shiftId);
    if (shift.status !== 'OPEN') throw conflict('SHIFT_NOT_OPEN');
    const net = this._cashFlows(shift);
    const expected = (shift.opening_cash_cents || 0) + net;
    const counted = Math.round(Number(countedCashCents));
    return tx(this.db, (db) => {
      db.prepare(`
        UPDATE shifts SET closed_at = ?, counted_cash_cents = ?, expected_cash_cents = ?, variance_cents = ?, status = 'CLOSED'
        WHERE id = ?
      `).run(new Date().toISOString(), counted, expected, counted - expected, shiftId);
      return this.get(shiftId);
    });
  }

  get(id) {
    const s = this.db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
    if (!s) throw notFound('SHIFT_NOT_FOUND');
    return s;
  }

  list({ user, limit = 100 } = {}) {
    const where = []; const vals = [];
    if (user) { where.push('user_id = ?'); vals.push(user); }
    return this.db.prepare(`
      SELECT s.*, u.username, u.full_name FROM shifts s LEFT JOIN users u ON u.id = s.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.id DESC LIMIT ?
    `).all(...vals, limit);
  }
}

export { EodService };