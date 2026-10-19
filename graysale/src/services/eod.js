import { tx, nextDoc } from '../db/database.js';
import { conflict, notFound } from '../lib/errors.js';
import { localStamp, nowLocal } from '../lib/ids.js';

// Shift stamps are local business time ('YYYY-MM-DD HH:MM:SS'), matching
// orders.created_at. Older rows may still carry ISO 'T'/ms/Z — normalize
// before range compares.
const normalizeStamp = (iso) => (iso || '').replace('T', ' ').replace(/\.\d+Z?$/, '');

// End-of-day cash reconciliation. A shift is the cash drawer session of one
// cashier/location. Expected cash draws from posted orders + cash payments.
export class EodService {
  constructor(db) {
    this.db = db;
  }

  open({ user, locationId, openingCashCents }) {
    const open = this.db.prepare("SELECT id FROM shifts WHERE user_id = ? AND status = 'OPEN'").get(user?.id);
    if (open) throw conflict('SHIFT_ALREADY_OPEN');
    return tx(this.db, () => {
      const docNo = nextDoc(this.db, 'SHIFT');
      const { lastInsertRowid } = this.db
        .prepare(
          `
        INSERT INTO shifts (doc_no, user_id, location_id, opening_cash_cents, status, opened_at)
        VALUES (?, ?, ?, ?, 'OPEN', ?)
      `,
        )
        .run(
          docNo,
          user?.id ?? null,
          locationId ?? user?.locationId ?? null,
          Math.round(Number(openingCashCents ?? 0)),
          nowLocal(),
        );
      return this.get(lastInsertRowid);
    });
  }

  // Sum the cash that flowed through the drawer for this shift.
  _cashFlows(shift) {
    const from = normalizeStamp(shift.opened_at || '0000-01-01 00:00:00');
    const to = normalizeStamp(shift.closed_at || localStamp(new Date(Date.now() + 60_000)));
    const fromDay = from.slice(0, 10);
    const toDay = to.slice(0, 10);

    // Cash received on POS sales (CASH method minus change) and layaway deposits,
    // less cash refunds, plus cash customer receipts, less cash supplier payments.
    const cashFlow = this.db.prepare(`
      SELECT COALESCE(SUM(cash_in), 0) - COALESCE(SUM(cash_out), 0) AS net FROM (
        SELECT json_extract(o.meta, '$.applied_cash') AS cash_in, 0 AS cash_out
        FROM orders o WHERE o.type = 'SALE' AND o.status = 'PAID'
          AND o.created_at >= ? AND o.created_at < ?
        UNION ALL
        SELECT json_extract(o.meta, '$.payments.CASH') AS cash_in, 0 AS cash_out
        FROM orders o WHERE o.type = 'LAYAWAY' AND o.status IN ('OPEN','COMPLETED')
          AND o.created_at >= ? AND o.created_at < ?
        UNION ALL
        SELECT 0 AS cash_in, json_extract(o.meta, '$.return_cash') AS cash_out
        FROM orders o WHERE o.type = 'REFUND' AND o.status = 'PAID'
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
    const net = cashFlow.get(from, to, from, to, from, to, fromDay, toDay, fromDay, toDay)?.net ?? 0;
    return net;
  }

  // Full shift report: payment-method breakdown, opening float, expected drawer,
  // layby totals and transaction counts. Scope is the single shift (optimal for
  // per-cashier X/Z reports).
  report(shiftId) {
    const shift = this.get(shiftId);
    const from = normalizeStamp(shift.opened_at || '0000-01-01 00:00:00');
    const to = normalizeStamp(shift.closed_at || localStamp(new Date(Date.now() + 60_000)));
    const person = this.db.prepare('SELECT username, full_name FROM users WHERE id = ?').get(shift.user_id) || {};

    const methodRows = this.db
      .prepare(
        `
      SELECT method, kind, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS n FROM (
        SELECT json_extract(o.meta, '$.applied_cash') AS amount, 'CASH' AS method,
               (o.type || '_SELL') AS kind
        FROM orders o WHERE o.type IN ('SALE','LAYAWAY') AND o.status IN ('PAID','OPEN','COMPLETED')
          AND o.created_at >= ? AND o.created_at < ?
        UNION ALL
        SELECT json_extract(o.meta, '$.payments.CASH'), 'CASH_LAYBY', 'LAYAWAY'
        FROM orders o WHERE o.type = 'LAYAWAY' AND o.status IN ('OPEN','COMPLETED')
          AND o.created_at >= ? AND o.created_at < ?
        UNION ALL
        SELECT json_extract(o.meta, '$.payments.CARD'), 'CARD', 'SALE'
        FROM orders o WHERE o.type = 'SALE' AND o.status = 'PAID' AND o.created_at >= ? AND o.created_at < ?
        UNION ALL
        SELECT json_extract(o.meta, '$.payments.MOBILE'), 'MOBILE', 'SALE'
        FROM orders o WHERE o.type = 'SALE' AND o.status = 'PAID' AND o.created_at >= ? AND o.created_at < ?
        UNION ALL
        SELECT json_extract(o.meta, '$.payments.BANK'), 'BANK', 'SALE'
        FROM orders o WHERE o.type = 'SALE' AND o.status = 'PAID' AND o.created_at >= ? AND o.created_at < ?
        UNION ALL
        SELECT json_extract(o.meta, '$.return_cash'), 'CASH_REFUND', 'REFUND'
        FROM orders o WHERE o.type = 'REFUND' AND o.status = 'PAID' AND o.created_at >= ? AND o.created_at < ?
      ) WHERE amount IS NOT NULL AND amount != 0
      GROUP BY method, kind ORDER BY method
    `,
      )
      .all(from, to, from, to, from, to, from, to, from, to, from, to);

    const breakdown = {};
    for (const r of methodRows) {
      if (r.kind === 'REFUND') {
        breakdown.cashRefund = (breakdown.cashRefund || 0) + r.amount;
      } else if (r.kind === 'LAYAWAY') {
        breakdown.layby = (breakdown.layby || 0) + r.amount;
      } else {
        breakdown[r.method.toLowerCase()] = (breakdown[r.method.toLowerCase()] || 0) + r.amount;
      }
    }
    // total across all value-holding buckets for easy printing
    breakdown.total =
      (breakdown.cash || 0) +
      (breakdown.card || 0) +
      (breakdown.mobile || 0) +
      (breakdown.bank || 0) +
      (breakdown.layby || 0);

    const saleCount = this.db
      .prepare(
        `
      SELECT COUNT(*) AS n FROM orders WHERE type = 'SALE' AND status = 'PAID'
        AND created_at >= ? AND created_at < ?
    `,
      )
      .get(from, to).n;

    const layby = this.db
      .prepare(
        `
      SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status='OPEN' THEN (total_cents - paid_cents) ELSE 0 END), 0) AS outstanding,
             COALESCE(SUM(paid_cents), 0) AS collected
      FROM orders WHERE type = 'LAYAWAY' AND status IN ('OPEN','COMPLETED') AND created_at >= ? AND created_at < ?
    `,
      )
      .get(from, to);

    const cashNet = this._cashFlows(shift);
    const expected = (shift.opening_cash_cents || 0) + cashNet;
    const counted = shift.counted_cash_cents ?? null;
    const variance = counted == null ? null : counted - expected;

    return {
      shift: {
        id: shift.id,
        doc_no: shift.doc_no,
        status: shift.status,
        opened_at: shift.opened_at,
        closed_at: shift.closed_at,
      },
      cashier: { username: person.username || null, full_name: person.full_name || null },
      opening_float_cents: shift.opening_cash_cents || 0,
      breakdown,
      cash_net_cents: cashNet,
      expected_cash_cents: expected,
      counted_cash_cents: counted,
      variance_cents: variance,
      sale_count: saleCount,
      layby: { count: layby.n, collected_cents: layby.collected, outstanding_cents: layby.outstanding },
    };
  }

  // Z-report: same figures as the X-report but auto-closes the shift on
  // generation. Optionally records the counted cash to compute variance.
  zReport(shiftId, { countedCashCents } = {}) {
    const shift = this.get(shiftId);
    if (shift.status !== 'OPEN') throw conflict('SHIFT_NOT_OPEN');
    const counted = countedCashCents != null ? Math.round(Number(countedCashCents)) : null;
    const rep = this.report(shiftId);
    return tx(this.db, () => {
      this.db
        .prepare(
          `
        UPDATE shifts SET closed_at = ?, counted_cash_cents = ?, expected_cash_cents = ?,
          variance_cents = ?, status = 'CLOSED'
        WHERE id = ?
      `,
        )
        .run(
          nowLocal(),
          counted ?? rep.expected_cash_cents,
          rep.expected_cash_cents,
          counted == null ? 0 : counted - rep.expected_cash_cents,
          shiftId,
        );
      const closed = this.get(shiftId);
      return {
        ...rep,
        shift: { ...rep.shift, status: 'CLOSED', closed_at: closed.closed_at },
        counted_cash_cents: counted,
        variance_cents: counted == null ? null : counted - rep.expected_cash_cents,
      };
    });
  }

  close({ shiftId, countedCashCents }) {
    const shift = this.get(shiftId);
    if (shift.status !== 'OPEN') throw conflict('SHIFT_NOT_OPEN');
    const net = this._cashFlows(shift);
    const expected = (shift.opening_cash_cents || 0) + net;
    const counted = Math.round(Number(countedCashCents));
    return tx(this.db, () => {
      this.db
        .prepare(
          `
        UPDATE shifts SET closed_at = ?, counted_cash_cents = ?, expected_cash_cents = ?, variance_cents = ?, status = 'CLOSED'
        WHERE id = ?
      `,
        )
        .run(nowLocal(), counted, expected, counted - expected, shiftId);
      return this.get(shiftId);
    });
  }

  get(id) {
    const s = this.db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
    if (!s) throw notFound('SHIFT_NOT_FOUND');
    return s;
  }

  list({ user, limit = 100 } = {}) {
    const where = [];
    const vals = [];
    if (user) {
      where.push('user_id = ?');
      vals.push(user);
    }
    return this.db
      .prepare(
        `
      SELECT s.*, u.username, u.full_name FROM shifts s LEFT JOIN users u ON u.id = s.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.id DESC LIMIT ?
    `,
      )
      .all(...vals, limit);
  }

  currentOpen(userId) {
    if (userId == null) return null;
    return (
      this.db
        .prepare(
          `
      SELECT s.*, u.username, u.full_name FROM shifts s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.user_id = ? AND s.status = 'OPEN'
    `,
        )
        .get(Number(userId)) || null
    );
  }
}
