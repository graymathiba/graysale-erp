// ---------------- Offline queue sync (Flutter POS) ----------------
// The till writes each sale to its own SQLite at checkout and replays the
// queue here once connectivity returns, so every sale in a batch may already
// have been booked on an earlier attempt. The client UUID `id` is the
// idempotency key: a replay answers `duplicates` instead of issuing a second
// receipt. Sales are processed independently so one malformed or
// out-of-stock sale cannot block the rest of the queue.

import { badRequest } from '../../lib/errors.js';
import { localStamp } from '../../lib/ids.js';
import { resolveTenantId } from '../../lib/tenant.js';
import { METHODS, SYNC_METHOD_ALIASES, SYNC_MAX_BATCH } from './shared.js';

export function installSync(PosService) {
  Object.assign(PosService.prototype, {
    syncSales({ sales, user }) {
      if (!Array.isArray(sales) || sales.length === 0) throw badRequest('SALES_REQUIRED');
      if (sales.length > SYNC_MAX_BATCH) throw badRequest(`BATCH_TOO_LARGE: max ${SYNC_MAX_BATCH} per request`);

      const syncedIds = [],
        duplicates = [],
        failed = [],
        priceDrift = [];

      for (const raw of sales) {
        const ref = String(raw?.id ?? '').trim();
        if (!ref) {
          failed.push({ id: null, error: 'MISSING_ID' });
          continue;
        }
        if (this.findByClientRef(ref, user)) {
          duplicates.push(ref);
          continue;
        }
        try {
          const res = this._syncOneSale(raw, ref, user);
          syncedIds.push(ref);
          if (res.driftCents !== 0) {
            priceDrift.push({
              id: ref,
              clientTotalCents: res.clientTotalCents,
              serverTotalCents: res.serverTotalCents,
              driftCents: res.driftCents,
            });
          }
        } catch (e) {
          // A UNIQUE violation on (tenant_id, client_ref) means a concurrent
          // batch booked this sale first — that is a duplicate, not a failure.
          if (/UNIQUE|constraint/i.test(String(e?.message))) {
            duplicates.push(ref);
            continue;
          }
          failed.push({ id: ref, error: String(e?.message || e).slice(0, 200) });
        }
      }
      return { success: failed.length === 0, syncedIds, duplicates, failed, priceDrift };
    },

    // Server-side record of an offline sale, matched on the client idempotency key.
    findByClientRef(ref, user) {
      return (
        this.db
          .prepare('SELECT id, doc_no, total_cents FROM orders WHERE client_ref = ? AND tenant_id = ?')
          .get(ref, user?.tenantId ?? resolveTenantId(this.db)) || null
      );
    },

    _syncOneSale(raw, ref, user) {
      const items = (Array.isArray(raw.lines) ? raw.lines : []).map((l) => ({
        productId: l.product_id ?? l.productId,
        qty: l.qty,
      }));
      if (items.length === 0) throw badRequest('LINES_REQUIRED');

      // Price from the server catalog, never from the device: the till may have
      // been offline while a price changed, and the ledger must reflect the
      // books, not whatever the client believed. Drift is reported, not hidden.
      const serverTotals = this._totals(
        items.map((i) => this.buildLine(i)),
        0,
      );
      const clientTotalCents = Number.isFinite(Number(raw.total_cents))
        ? Math.round(Number(raw.total_cents))
        : serverTotals.total;

      const method = this._syncPaymentMethod(raw.payment_method ?? raw.paymentMethod);
      const order = this.checkout({
        items,
        payments: [{ method, amountCents: serverTotals.total }],
        customerId: raw.customer_id ?? raw.customerId ?? null,
        note: raw.note ? String(raw.note).slice(0, 200) : `offline sync ${ref}`,
        user,
        clientRef: ref,
        createdAt: this._syncTimestamp(raw.created_at ?? raw.createdAt),
      });

      this.auth.audit(user?.id, user?.username, 'SALE_SYNC', 'order', order.id, order.doc_no);
      return {
        clientTotalCents,
        serverTotalCents: serverTotals.total,
        driftCents: serverTotals.total - clientTotalCents,
      };
    },

    _syncPaymentMethod(raw) {
      const key = String(raw ?? '')
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, '_');
      const alias = SYNC_METHOD_ALIASES[key];
      const method = alias || key;
      if (!METHODS.has(method)) throw badRequest(`INVALID_PAYMENT_METHOD: ${raw}`);
      return method;
    },

    // Accept an offline device timestamp; fall back to server time when absent
    // or unusable. Anything unparseable must not silently become "now" data.
    // The instant is converted to this machine's business clock, matching the
    // local stamps orders get at the server — an offline sale rung at 23:50
    // must stay on that business day even if it replays after midnight.
    _syncTimestamp(raw) {
      if (!raw) return null;
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) throw badRequest(`INVALID_CREATED_AT: ${raw}`);
      return localStamp(d);
    },
  });
}
