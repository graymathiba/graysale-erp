// ---------------- EcoCash C2B (two-phase payment) ----------------
// The customer pays by phone: we create a reserved, not-yet-paid order, push
// a C2B prompt to the provider, then settle the sale only when the provider
// confirms (poll or webhook). No journal, stock movement or fiscal receipt is
// written until the money actually lands.

import { tx } from '../../db/database.js';
import { badRequest, notFound, conflict } from '../../lib/errors.js';
import { todayLocal } from '../../lib/ids.js';
import { cashTarget } from './shared.js';

export function installEcocash(PosService) {
  Object.assign(PosService.prototype, {
    async ecocashInitiate({ items, payments, phone, customerId, orderDiscountPercent, note, user }) {
      if (!Array.isArray(items) || items.length === 0) throw badRequest('ITEMS_REQUIRED');
      const lines = items.map((i) => this.buildLine(i));
      const totals = this._totals(lines, orderDiscountPercent);
      const { splits, credited } = this._validatePayments(payments);
      if (credited > 0) throw badRequest('ECOCASH_SALE_CANNOT_BE_CREDIT');
      if (!splits.ECOCASH || Object.keys(splits).length !== 1) throw badRequest('SINGLE_ECOCASH_PAYMENT_REQUIRED');
      if (splits.ECOCASH !== totals.total)
        throw badRequest(`ECOCASH_AMOUNT_MUST_EQUAL_TOTAL: got ${splits.ECOCASH}, need ${totals.total}`);

      for (const l of lines) {
        if (l.product.is_bundle && l.bundle_components) {
          for (const c of l.bundle_components) {
            if (this.catalog.available(c.productId) < c.qty)
              throw conflict(`INSUFFICIENT_STOCK: ${c.productId} (bundle component of ${l.product.name})`);
          }
        } else if (this.catalog.available(l.product.id) < l.qty) {
          throw conflict(`INSUFFICIENT_STOCK: ${l.product.name}`);
        }
      }

      const pendingLines = lines.map((l) => ({
        productId: l.product.id,
        recipe: {
          qty: l.qty,
          unit_cents: l.unit_cents,
          line_gross: l.line_gross,
          line_discount: l.line_discount,
          tax_cents: l.tax_cents,
          line_total: l.line_total,
        },
        is_bundle: !!l.product.is_bundle,
        bundle_components: l.bundle_components
          ? l.bundle_components.map((c) => ({ productId: c.productId, qty: c.qty }))
          : null,
      }));

      const sale = tx(this.db, () => {
        const { id, docNo } = this._insertOrder({
          type: 'SALE',
          status: 'AWAITING_PAYMENT',
          lines,
          totals,
          customerId,
          user,
          note,
          meta: JSON.stringify({ payments: splits, pending_eco: true, pending_lines: pendingLines }),
        });
        for (const l of lines) {
          if (l.product.is_bundle && l.bundle_components) {
            for (const c of l.bundle_components) this.catalog.reserve(c.productId, c.qty, 'order', id);
          } else {
            this.catalog.reserve(l.product.id, l.qty, 'order', id);
          }
        }
        this.db.prepare("UPDATE orders SET ecocash_status = 'PENDING' WHERE id = ?").run(id);
        this.auth.audit(user?.id, user?.username, 'ECOCASH_INITIATE', 'order', id, docNo);
        return { id, docNo };
      });

      let txn;
      try {
        const init = await this.eco.initiateTxn({
          orderId: sale.id,
          kind: 'C2B_PAYMENT',
          amountCents: totals.total,
          phone,
          user,
        });
        txn = init.txn;
      } catch (err) {
        // Order + reservation already committed above; if the EcoCash leg fails
        // (disabled, bad phone, provider error) the sale can never be settled by
        // a callback — void it and release the stock so it is not trapped.
        this._abandonEcoSale(sale.id, user, 'CANCELLED');
        throw err;
      }
      this.db.prepare('UPDATE orders SET ecocash_reference = ? WHERE id = ?').run(txn.reference, sale.id);
      return {
        ...this.getOrder(sale.id),
        eco: { reference: txn.reference, providerRef: txn.provider_ref, status: txn.status },
      };
    },

    async ecocashStatus(orderId, user) {
      const order = this.getOrder(orderId);
      if (order.type !== 'SALE' || order.status !== 'AWAITING_PAYMENT') throw conflict('NOT_AWAITING_ECOCASH_SALE');
      const polled = await this.eco.poll(orderId, user);
      if (polled.status === 'COMPLETED') return this._finalizeEcoSale(orderId, user);
      if (polled.status === 'FAILED' || polled.status === 'CANCELLED')
        return this._abandonEcoSale(orderId, user, polled.status);
      return this.getOrder(orderId);
    },

    // Webhook settlement — no HTTP user, so the recording cashier is resolved
    // from the order. Idempotent for replayed callbacks.
    async completeEcoCash(reference) {
      const txn = this.eco.byReference(reference);
      if (!txn) throw notFound('ECO_TXN_NOT_FOUND');
      const order = this.getOrder(txn.order_id);
      if (order.status === 'PAID') return order;
      if (order.status === 'VOID') {
        if (txn.status === 'COMPLETED') throw conflict('ECO_PAID_AFTER_VOID');
        return order; // replayed failure/cancel: already resolved
      }
      if (order.status !== 'AWAITING_PAYMENT') return order;
      const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(order.user_id);
      const effective = u ? { ...u, tenantId: u.tenant_id || u.tenantId } : null;
      if (txn.kind === 'C2B_REFUND' && txn.status === 'COMPLETED') return this._finalizeEcoRefund(txn, effective);
      if (txn.status === 'COMPLETED') return this._finalizeEcoSale(txn.order_id, effective);
      if (
        txn.status === 'FAILED' ||
        txn.status === 'CANCELLED' ||
        txn.status === 'TIMED_OUT' ||
        txn.status === 'EXPIRED'
      ) {
        return this._abandonEcoSale(txn.order_id, effective, txn.status);
      }
      return order;
    },

    ecocashCancel(orderId, user) {
      const order = this.getOrder(orderId);
      if (order.status !== 'AWAITING_PAYMENT') throw conflict('NOT_AWAITING_ECOCASH_SALE');
      this.eco.cancelOrder(orderId, user);
      return this._abandonEcoSale(orderId, user, 'CANCELLED');
    },

    _releaseEco(lines, orderId) {
      for (const l of lines) {
        if (l.product.is_bundle && l.bundle_components) {
          for (const c of l.bundle_components) this.catalog.release(c.productId, c.qty, 'order', orderId);
        } else {
          this.catalog.release(l.product.id, l.qty, 'order', orderId);
        }
      }
    },

    // Rebuild in-memory line objects (with product + bundle components) from the
    // serialized shape stored at initiate time, so a webhook-settled EcoCash sale
    // keeps journal + stock parity with a normal checkout.
    _linesFromPending(order) {
      let meta = {};
      try {
        meta = JSON.parse(order.meta || '{}');
      } catch {
        meta = {};
      }
      return (meta.pending_lines || []).map((l) => ({
        ...l.recipe,
        product: this.catalog.getProduct(l.productId),
        is_bundle: !!l.is_bundle,
        bundle_components: l.bundle_components
          ? l.bundle_components.map((c) => ({ productId: c.productId, qty: c.qty }))
          : undefined,
      }));
    },

    _finalizeEcoSale(orderId, user) {
      const order = this.getOrder(orderId);
      if (order.status !== 'AWAITING_PAYMENT') throw conflict('ORDER_NOT_AWAITING_PAYMENT');
      const txn = this.eco.byOrder(orderId, 'C2B_PAYMENT');
      if (!txn || txn.status !== 'COMPLETED') throw conflict('ECO_NOT_COMPLETED');
      return tx(this.db, () => {
        const lines = this._linesFromPending(order);
        this._releaseEco(lines, orderId);
        const meta = { ...JSON.parse(order.meta || '{}'), payments: { ECOCASH: order.total_cents } };
        this.db
          .prepare(
            "UPDATE orders SET status = 'PAID', paid_cents = total_cents, ecocash_status = 'COMPLETED', meta = ? WHERE id = ?",
          )
          .run(JSON.stringify(meta), orderId);
        const totals = {
          subtotal: order.subtotal_cents,
          discount: order.discount_cents,
          tax: order.tax_cents,
          total: order.total_cents,
        };
        this._materializeSale({
          id: orderId,
          docNo: order.doc_no,
          lines,
          totals,
          splits: { ECOCASH: order.total_cents },
          appliedCash: 0,
          appliedBank: order.total_cents,
          credited: 0,
          change: 0,
          customerId: order.customer_id,
          user,
          note: order.note,
        });
        const sale = this.getOrder(orderId);
        return this._maybeEnqueueFiscal(sale, user);
      });
    },

    _abandonEcoSale(orderId, user, reason) {
      const order = this.getOrder(orderId);
      if (order.status !== 'AWAITING_PAYMENT') throw conflict('ORDER_NOT_AWAITING_PAYMENT');
      return tx(this.db, () => {
        this._releaseEco(this._linesFromPending(order), orderId);
        this.db.prepare("UPDATE orders SET status = 'VOID', ecocash_status = ? WHERE id = ?").run(reason, orderId);
        this.auth.audit(user?.id, user?.username, 'ECOCASH_FAILED', 'order', orderId, order.doc_no);
        return this.getOrder(orderId);
      });
    },

    // Refund that pays OUT through EcoCash (two-phase, phone confirmation).
    async ecocashRefund({ saleId, items, phone, reason, user }) {
      const sale = this.getOrder(saleId);
      if (sale.type !== 'SALE' || sale.status !== 'PAID') throw conflict('NOT_A_PAID_SALE');
      const remaining = sale.total_cents - sale.refunded_cents;
      if (remaining <= 0) throw conflict('ALREADY_FULLY_REFUNDED');
      if (!Array.isArray(items) || items.length === 0) throw badRequest('ITEMS_REQUIRED');
      const lines = items.map((it) => {
        const orig = sale.lines.find((l) => l.product_id === it.productId);
        if (!orig) throw notFound(`PRODUCT_NOT_ON_SALE: ${it.productId}`);
        const qty = Math.round(Number(it.qty));
        if (qty < 1 || qty > orig.qty) throw badRequest(`INVALID_QTY: ${orig.product_name}`);
        return this.buildLine({ productId: orig.product_id, qty, unitPriceCents: orig.unit_price_cents });
      });
      const totals = this._totals(lines, 0);
      if (totals.total > remaining) throw badRequest('REFUND_EXCEEDS_REMAINING');
      const pendingLines = lines.map((l) => ({
        productId: l.product.id,
        recipe: {
          qty: l.qty,
          unit_cents: l.unit_cents,
          line_gross: l.line_gross,
          line_discount: l.line_discount,
          tax_cents: l.tax_cents,
          line_total: l.line_total,
        },
        is_bundle: !!l.product.is_bundle,
        bundle_components: l.bundle_components
          ? l.bundle_components.map((c) => ({ productId: c.productId, qty: c.qty }))
          : null,
      }));
      const refundId = tx(this.db, () => {
        const { id, docNo } = this._insertOrder({
          type: 'REFUND',
          status: 'AWAITING_PAYMENT',
          lines,
          totals: {
            ...totals,
            subtotal: -totals.subtotal,
            discount: -totals.discount,
            tax: -totals.tax,
            total: -totals.total,
          },
          customerId: sale.customer_id,
          user,
          note: reason || '',
          meta: JSON.stringify({
            return_cash: totals.total,
            method: 'ECOCASH',
            original_id: sale.id,
            pending_refund: true,
            pending_lines: pendingLines,
          }),
        });
        this.auth.audit(user?.id, user?.username, 'ECOCASH_REFUND_INITIATE', 'order', id, docNo);
        return id;
      });
      const txn = await this.eco.refundTxn({ saleId: refundId, amountCents: totals.total, phone, user });
      return {
        ...this.getOrder(refundId),
        eco: { reference: txn.reference, providerRef: txn.provider_ref, status: txn.status },
      };
    },

    _finalizeEcoRefund(txn, user) {
      const order = this.getOrder(txn.order_id);
      if (order.status !== 'AWAITING_PAYMENT') throw conflict('ORDER_NOT_AWAITING_PAYMENT');
      return tx(this.db, () => {
        const lines = this._linesFromPending(order);
        for (const l of lines) {
          this.catalog.move({
            productId: l.product.id,
            qty: l.qty,
            type: 'REFUND',
            refType: 'order',
            refId: order.id,
            note: order.doc_no,
            userId: user?.id,
          });
        }
        const cogs = lines.reduce((s, l) => s + l.qty * l.product.cost_cents, 0);
        const amount = Math.abs(order.total_cents);
        const originalId = JSON.parse(order.meta || '{}').original_id ?? null;
        this.acct.postEntry({
          date: todayLocal(),
          description: `Refund ${order.doc_no} of ${originalId ? '#' + originalId : 'sale'}`,
          reference: order.doc_no,
          lines: [
            { code: '4200', debit: Math.abs(order.subtotal_cents - order.discount_cents), credit: 0 },
            { code: '2100', debit: Math.abs(order.tax_cents), credit: 0 },
            { code: cashTarget('ECOCASH'), debit: 0, credit: amount },
            { code: '1200', debit: cogs, credit: 0 },
            { code: '5100', debit: 0, credit: cogs },
          ],
          user,
        });
        this.db
          .prepare(
            "UPDATE orders SET status = 'PAID', paid_cents = total_cents, ecocash_status = 'COMPLETED' WHERE id = ?",
          )
          .run(txn.order_id);
        if (originalId) {
          this.db.prepare('UPDATE orders SET refunded_cents = refunded_cents + ? WHERE id = ?').run(amount, originalId);
        }
        this.auth.audit(user?.id, user?.username, 'ECOCASH_REFUND_COMPLETE', 'order', txn.order_id, order.doc_no);
        const refund = this.getOrder(txn.order_id);
        return this._maybeEnqueueFiscal(refund, user);
      });
    },
  });
}
