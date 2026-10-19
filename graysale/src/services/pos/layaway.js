// ---------------- Layaway ----------------
// Stock is reserved at creation, released and sold on completion (or on
// cancel), and the deposit/final payments each post their own journal entry.

import { tx } from '../../db/database.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { todayLocal } from '../../lib/ids.js';
import { cashTarget } from './shared.js';

export function installLayaway(PosService) {
  Object.assign(PosService.prototype, {
    createLayaway({ items, customerId, deposit, discountPercent, note, user }) {
      if (!customerId) throw badRequest('LAYAWAY_REQUIRES_CUSTOMER');
      if (!Array.isArray(items) || items.length === 0) throw badRequest('ITEMS_REQUIRED');
      const lines = items.map((i) => this.buildLine(i));
      const totals = this._totals(lines, discountPercent);
      const dep = Math.round(Number(deposit ?? 0));
      if (dep < 0) throw badRequest('NEGATIVE_DEPOSIT');
      for (const l of lines) {
        if (l.product.is_bundle && l.bundle_components) {
          for (const c of l.bundle_components) {
            if (this.catalog.available(c.productId) < c.qty)
              throw conflict(`INSUFFICIENT_STOCK: ${c.productId} (bundle component)`);
          }
        } else if (this.catalog.available(l.product.id) < l.qty) {
          throw conflict(`INSUFFICIENT_STOCK: ${l.product.name}`);
        }
      }
      return tx(this.db, () => {
        const { id, docNo } = this._insertOrder({
          type: 'LAYAWAY',
          status: 'OPEN',
          lines,
          totals,
          customerId,
          user,
          note,
          paidCents: dep,
          meta: JSON.stringify({ deposit: dep, payments: { CASH: dep } }),
        });
        // reserve stock
        for (const l of lines) {
          if (l.product.is_bundle && l.bundle_components) {
            for (const c of l.bundle_components) this.catalog.reserve(c.productId, c.qty, 'order', id);
          } else {
            this.catalog.reserve(l.product.id, l.qty, 'order', id);
          }
        }
        // journal deposit
        this.acct.postEntry({
          date: todayLocal(),
          description: `Layaway deposit ${docNo}`,
          reference: docNo,
          lines: [
            { code: '1000', amount: dep },
            { code: '2200', amount: dep },
          ],
          user,
        });
        this.auth.audit(user?.id, user?.username, 'LAYAWAY_CREATE', 'order', id, docNo);
        return this.getOrder(id);
      });
    },

    addLayawayPayment(orderId, payments, user) {
      const order = this.getOrder(orderId);
      if (order.type !== 'LAYAWAY' || order.status !== 'OPEN') throw conflict('ORDER_NOT_OPEN_LAYAWAY');
      const { splits, credited } = this._validatePayments(payments);
      if (credited > 0) throw badRequest('LAYAWAY_DEPOSITS_MUST_BE_CASH_LIKE');
      const amount = Object.values(splits).reduce((a, b) => a + b, 0);
      if (order.paid_cents + amount > order.total_cents) throw badRequest('PAYMENT_EXCEEDS_BALANCE');
      return tx(this.db, () => {
        const newPaid = order.paid_cents + amount;
        const prev = JSON.parse(order.meta || '{}');
        this.db.prepare('UPDATE orders SET paid_cents = ?, meta = ? WHERE id = ?').run(
          newPaid,
          JSON.stringify({
            ...prev,
            payments: { CASH: (prev.payments?.CASH || prev.deposit || 0) + amount },
          }),
          orderId,
        );
        this.acct.postEntry({
          date: todayLocal(),
          description: `Layaway payment ${order.doc_no}`,
          reference: order.doc_no,
          lines: [
            { code: cashTarget('CASH'), amount },
            { code: '2200', amount },
          ],
          user,
        });
        return this.getOrder(orderId);
      });
    },

    finalizeLayaway(orderId, payments, user) {
      const order = this.getOrder(orderId);
      if (order.type !== 'LAYAWAY' || order.status !== 'OPEN') throw conflict('ORDER_NOT_OPEN_LAYAWAY');
      const { splits, credited } = this._validatePayments(payments);
      if (credited > 0) throw badRequest('FINAL_PAYMENT_MUST_BE_CASH_LIKE');
      const final = Object.values(splits).reduce((a, b) => a + b, 0);
      const remaining = order.total_cents - order.paid_cents;
      if (final < remaining) throw badRequest(`PARTIAL_FINAL: ${final} < ${remaining}`);
      const change = final - remaining;

      return tx(this.db, () => {
        this.db.prepare("UPDATE orders SET status = 'COMPLETED', paid_cents = total_cents, meta = ? WHERE id = ?").run(
          JSON.stringify({
            ...JSON.parse(order.meta || '{}'),
            final_amt: final,
            payments: { CASH: order.paid_cents + final - change },
          }),
          orderId,
        );
        const cogs = order.lines.reduce(
          (s, l) => s + l.qty * (this.catalog.getProduct(l.product_id).cost_cents || 0),
          0,
        );
        for (const l of order.lines) {
          this.catalog.release(l.product_id, l.qty, 'order', orderId);
          this.catalog.move({
            productId: l.product_id,
            qty: -l.qty,
            type: 'SALE',
            refType: 'order',
            refId: orderId,
            note: `layaway ${order.doc_no}`,
            userId: user?.id,
          });
        }
        const deposits = order.paid_cents;
        this.acct.postEntry({
          date: todayLocal(),
          description: `Layaway completion ${order.doc_no}`,
          reference: order.doc_no,
          lines: [
            { code: '2200', debit: deposits, credit: 0 },
            { code: '1000', debit: order.total_cents - deposits, credit: 0 },
            { code: '4100', debit: order.discount_cents, credit: 0 },
            { code: '4000', debit: 0, credit: order.subtotal_cents },
            { code: '2100', debit: 0, credit: order.tax_cents },
            { code: '5100', debit: cogs, credit: 0 },
            { code: '1200', debit: 0, credit: cogs },
          ],
          user,
        });
        if (order.customer_id) {
          this.db
            .prepare('UPDATE customers SET loyalty_points = loyalty_points + ? WHERE id = ?')
            .run(Math.floor(order.total_cents / 100), order.customer_id);
        }
        return this.getOrder(orderId);
      });
    },

    cancelLayaway(orderId, user) {
      const order = this.getOrder(orderId);
      if (order.type !== 'LAYAWAY' || order.status !== 'OPEN') throw conflict('ORDER_NOT_OPEN_LAYAWAY');
      return tx(this.db, () => {
        this.db.prepare("UPDATE orders SET status = 'VOID' WHERE id = ?").run(orderId);
        for (const l of order.lines) this.catalog.release(l.product_id, l.qty, 'order', orderId);
        if (order.paid_cents > 0) {
          this.acct.postEntry({
            date: todayLocal(),
            description: `Layaway refund ${order.doc_no}`,
            reference: order.doc_no,
            lines: [
              { code: '2200', debit: order.paid_cents, credit: 0 },
              { code: '1000', debit: 0, credit: order.paid_cents },
            ],
            user,
          });
        }
        this.auth.audit(user?.id, user?.username, 'LAYAWAY_VOID', 'order', orderId, order.doc_no);
        return this.getOrder(orderId);
      });
    },
  });
}
