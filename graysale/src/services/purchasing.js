import { tx, nextDoc } from '../db/database.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { taxOn } from '../lib/money.js';
import { todayLocal } from '../lib/ids.js';

export class PurchasingService {
  constructor({ db, catalog, invoicing, auth }) {
    this.db = db;
    this.catalog = catalog;
    this.invoicing = invoicing;
    this.auth = auth;
  }

  poItems(poId) {
    const items = this.db
      .prepare(
        `
      SELECT pl.*, p.name AS product_name, p.cost_cents AS current_cost, t.rate_bps AS tax_rate_bps
      FROM po_lines pl
      JOIN products p ON p.id = pl.product_id
      LEFT JOIN tax_classes t ON t.id = pl.tax_class_id
      WHERE pl.po_id = ? ORDER BY pl.id
    `,
      )
      .all(poId);
    return items;
  }

  getPo(id) {
    const po = this.db
      .prepare(
        `
      SELECT po.*, s.name AS supplier_name FROM purchase_orders po
      JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?
    `,
      )
      .get(id);
    if (!po) throw notFound('PO_NOT_FOUND');
    po.lines = this.poItems(id);
    return po;
  }

  list({ status, supplierId, limit = 100 } = {}) {
    const where = ['1=1'];
    const vals = [];
    if (status) {
      where.push('po.status = ?');
      vals.push(status);
    }
    if (supplierId) {
      where.push('po.supplier_id = ?');
      vals.push(supplierId);
    }
    return this.db
      .prepare(
        `
      SELECT po.*, s.name AS supplier_name FROM purchase_orders po
      JOIN suppliers s ON s.id = po.supplier_id
      WHERE ${where.join(' AND ')} ORDER BY po.id DESC LIMIT ?
    `,
      )
      .all(...vals, limit);
  }

  _computeLines(items) {
    return items.map((it) => {
      const product = this.catalog.getProduct(it.productId);
      if (!product.active) throw conflict(`PRODUCT_INACTIVE: ${product.name}`);
      const qty = Math.round(Number(it.qty));
      if (!Number.isInteger(qty) || qty < 1) throw badRequest('QTY_MUST_BE_POSITIVE_INTEGER');
      const unitCost = Math.round(Number(it.unitCostCents ?? product.cost_cents));
      const taxClassId = it.taxClassId ?? product.tax_class_id ?? null;
      const taxRate = this.db.prepare('SELECT rate_bps FROM tax_classes WHERE id = ?').get(taxClassId)?.rate_bps ?? 0;
      const lineTotal = qty * unitCost;
      return { product, qty, unitCost, taxClassId, taxRate, lineTotal, tax: taxOn(lineTotal, taxRate) };
    });
  }

  createPo({ supplierId, items, expectedDate, note, user }) {
    if (!supplierId) throw badRequest('SUPPLIER_REQUIRED');
    if (!Array.isArray(items) || !items.length) throw badRequest('ITEMS_REQUIRED');
    const lines = this._computeLines(items);
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const tax = lines.reduce((s, l) => s + l.tax, 0);
    return tx(this.db, () => {
      const docNo = nextDoc(this.db, 'PO');
      const { lastInsertRowid } = this.db
        .prepare(
          `
        INSERT INTO purchase_orders (doc_no, supplier_id, status, expected_date, subtotal_cents, tax_cents, total_cents, note)
        VALUES (?, ?, 'DRAFT', ?, ?, ?, ?, ?)
      `,
        )
        .run(docNo, supplierId, expectedDate ?? null, subtotal, tax, subtotal + tax, note ?? '');
      const ins = this.db.prepare(`
        INSERT INTO po_lines (po_id, product_id, qty, qty_received, unit_cost_cents, tax_class_id, line_total_cents)
        VALUES (?, ?, ?, 0, ?, ?, ?)
      `);
      for (const l of lines) ins.run(lastInsertRowid, l.product.id, l.qty, l.unitCost, l.taxClassId, l.lineTotal);
      this.auth.audit(user?.id, user?.username, 'PO_CREATE', 'purchase_order', lastInsertRowid, docNo);
      return this.getPo(lastInsertRowid);
    });
  }

  placePo(id) {
    const po = this.getPo(id);
    if (po.status !== 'DRAFT') throw conflict('PO_NOT_DRAFT');
    this.db.prepare("UPDATE purchase_orders SET status = 'ORDERED' WHERE id = ?").run(id);
    return this.getPo(id);
  }

  receivePo({ poId, items, note, user }) {
    const po = this.getPo(poId);
    if (po.status !== 'ORDERED') throw conflict(`PO_NOT_ORDERED (status=${po.status})`);
    if (!Array.isArray(items) || !items.length) throw badRequest('ITEMS_REQUIRED');
    const grDoc = nextDoc(this.db, 'GR');
    return tx(this.db, () => {
      const { lastInsertRowid } = this.db
        .prepare(
          'INSERT INTO goods_receipts (doc_no, po_id, supplier_id, date, user_id, note) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(grDoc, poId, po.supplier_id, todayLocal(), user?.id ?? null, note ?? '');

      let subtotal = 0,
        tax = 0;
      for (const it of items) {
        const line = po.lines.find((l) => l.product_id === it.productId);
        if (!line) throw notFound(`PO_LINE_NOT_FOUND: ${it.productId}`);
        const qty = Math.round(Number(it.qty));
        if (!Number.isInteger(qty) || qty < 1) throw badRequest('QTY_MUST_BE_POSITIVE_INTEGER');
        if (line.qty_received + qty > line.qty) throw conflict(`OVERRECEIPT for product ${line.product_id}`);
        this.db.prepare('UPDATE po_lines SET qty_received = qty_received + ? WHERE id = ?').run(qty, line.id);

        // weighted-average unit cost BEFORE stock-in so on_hand excludes incoming qty
        this.recost(line.product_id, line.unit_cost_cents, qty);
        // stock in
        this.catalog.move({
          productId: line.product_id,
          qty,
          type: 'RECEIPT',
          refType: 'goods_receipt',
          refId: lastInsertRowid,
          note: grDoc,
          userId: user?.id,
        });
        subtotal += qty * line.unit_cost_cents;
        tax += taxOn(qty * line.unit_cost_cents, line.tax_rate_bps ?? 0);
      }
      const newStatus = po.lines.every(
        (l) => l.qty_received + (items.find((i) => i.productId === l.product_id)?.qty ?? 0) >= l.qty,
      )
        ? 'RECEIVED'
        : 'PARTIAL';
      this.db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(newStatus, poId);

      const bill = this.invoicing.createApBill({
        supplierId: po.supplier_id,
        poId,
        subtotalCents: subtotal,
        taxCents: tax,
        note: `Goods receipt ${grDoc} on ${po.doc_no}`,
      });
      this.auth.audit(user?.id, user?.username, 'PO_RECEIVE', 'purchase_order', poId, `${grDoc} -> ${bill.doc_no}`);
      return { grId: lastInsertRowid, grNo: grDoc, bill };
    });
  }

  // Weighted-average cost recalc. Called inside a transaction.
  recost(productId, incomingCostCents, incomingQty) {
    const cur = this.catalog.qtyOnHand(productId);
    const prod = this.catalog.getProduct(productId);
    const onHand = cur.qty_on_hand;
    const prevCost = prod.cost_cents || 0;
    if (onHand + incomingQty > 0) {
      const newCost = Math.round((prevCost * onHand + incomingCostCents * incomingQty) / (onHand + incomingQty));
      this.db.prepare('UPDATE products SET cost_cents = ? WHERE id = ?').run(newCost, productId);
    }
  }

  goodsReceipts({ limit = 100 } = {}) {
    return this.db
      .prepare(
        `
      SELECT gr.*, po.doc_no AS po_no, s.name AS supplier_name FROM goods_receipts gr
      JOIN purchase_orders po ON po.id = gr.po_id
      JOIN suppliers s ON s.id = gr.supplier_id
      ORDER BY gr.id DESC LIMIT ?
    `,
      )
      .all(limit);
  }

  grLines(grId) {
    return this.db
      .prepare(
        `
      SELECT * FROM stock_movements WHERE ref_type = 'goods_receipt' AND ref_id = ?
    `,
      )
      .all(grId);
  }
}
