// ---------------- Quote ----------------
// Quotes are priced snapshots with no stock or journal impact; converting one
// runs a normal checkout for the quoted lines and marks the quote CONVERTED.

import { tx } from '../../db/database.js';
import { badRequest, conflict } from '../../lib/errors.js';

export function installQuotes(PosService) {
  Object.assign(PosService.prototype, {
    createQuote({ items, customerId, discountPercent, note, user }) {
      if (!Array.isArray(items) || items.length === 0) throw badRequest('ITEMS_REQUIRED');
      const lines = items.map((i) => this.buildLine(i));
      const totals = this._totals(lines, discountPercent);
      return tx(this.db, () => {
        const { id, docNo } = this._insertOrder({
          type: 'QUOTE',
          status: 'OPEN',
          lines,
          totals,
          customerId,
          user,
          note,
        });
        this.auth.audit(user?.id, user?.username, 'QUOTE_CREATE', 'order', id, docNo);
        return this.getOrder(id);
      });
    },

    convertQuote(orderId, payments, user) {
      const order = this.getOrder(orderId);
      if (order.type !== 'QUOTE' || order.status !== 'OPEN') throw conflict('ORDER_NOT_OPEN_QUOTE');
      const items = order.lines.map((l) => ({
        productId: l.product_id,
        qty: l.qty,
        unitPriceCents: l.unit_price_cents,
        lineDiscountCents: l.line_discount_cents,
      }));
      const sale = this.checkout({
        items,
        payments,
        customerId: order.customer_id,
        note: `from quote ${order.doc_no}`,
        user,
      });
      tx(this.db, () => {
        this.db.prepare("UPDATE orders SET status = 'CONVERTED' WHERE id = ?").run(orderId);
      });
      return sale;
    },
  });
}
