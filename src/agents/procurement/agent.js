import { Agent } from '../agent.js';
import { createResult, createAuditEntry, ResultStatus } from '../message.js';

class ProcurementAgent extends Agent {
  constructor(store) {
    super({
      name: 'PROC_AGENT',
      role: 'Procurement — Purchase Orders, Vendor Management, 3-Way Match',
      capabilities: [
        'po.create', 'po.receive', 'po.partial_receive', 'po.cancel', 'po.list', 'po.get',
        'vendor.list', 'vendor.create', 'vendor.evaluate',
        'invoice.match_3way',
      ],
    });
    this.store = store;
  }

  async handle(message) {
    const { domain, payload } = message;

    switch (domain) {
      case 'po.create': return this.createPO(payload);
      case 'po.receive': return this.receivePO(payload);
      case 'po.partial_receive': return this.partialReceive(payload);
      case 'po.cancel': return this.cancelPO(payload);
      case 'po.list': return this.listPOs();
      case 'po.get': return this.getPO(payload);
      case 'purchase.create': return this.createPO(payload);
      case 'purchase.receive': return this.receivePO(payload);
      case 'vendor.list': return this.listVendors();
      case 'vendor.create': return this.createVendor(payload);
      case 'vendor.evaluate': return this.evaluateVendor(payload);
      case 'invoice.match_3way': return this.threeWayMatch(payload);
      default: return createResult({ status: ResultStatus.FAILURE, error: `Unknown procurement action: ${domain}` });
    }
  }

  createPO({ supplierId, items }) {
    const db = this.store.db;
    db.exec('BEGIN');
    try {
      const poNo = `PO-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const totalCents = items.reduce((s, i) => s + i.unitCostCents * i.qty, 0);
      const po = db.prepare(
        'INSERT INTO purchase_orders (po_no, supplier_id, total_cents, status) VALUES (?, ?, ?, ?)'
      ).run(poNo, supplierId, totalCents, 'open');
      const poId = po.lastInsertRowid;

      const ins = db.prepare(
        'INSERT INTO purchase_order_items (po_id, product_id, qty, unit_cost_cents, line_total_cents) VALUES (?, ?, ?, ?, ?)'
      );
      for (const i of items) {
        ins.run(poId, i.productId, i.qty, i.unitCostCents, i.unitCostCents * i.qty);
      }

      db.exec('COMMIT');
      return createResult({
        data: { poId, poNo, totalCents, status: 'open' },
        audit: [createAuditEntry(this.name, 'create_po', poNo)],
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  receivePO({ poId }) {
    const db = this.store.db;
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
    if (!po) return createResult({ status: ResultStatus.FAILURE, error: 'PO_NOT_FOUND' });
    if (po.status !== 'open') return createResult({ status: ResultStatus.FAILURE, error: `PO status is ${po.status}` });

    db.exec('BEGIN');
    try {
      const items = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(poId);
      for (const it of items) {
        const row = db.prepare('SELECT quantity FROM inventory WHERE product_id = ?').get(it.product_id);
        const newQty = (row?.quantity ?? 0) + it.qty;
        if (row) {
          db.prepare("UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ?").run(newQty, it.product_id);
        } else {
          db.prepare('INSERT INTO inventory (product_id, quantity, reorder_level) VALUES (?, ?, 10)').run(it.product_id, newQty);
        }
        db.prepare("INSERT INTO inventory_movements (product_id, quantity, type, note) VALUES (?, ?, 'RECEIPT', ?)").run(
          it.product_id, it.qty, `PO ${po.po_no}`
        );
        db.prepare('UPDATE purchase_order_items SET received_qty = ? WHERE id = ?').run(it.qty, it.id);
      }

      db.prepare("UPDATE purchase_orders SET status = 'received' WHERE id = ?").run(poId);
      db.exec('COMMIT');
      return createResult({
        data: { poId, itemsReceived: items.length },
        audit: [createAuditEntry(this.name, 'receive_po', po.po_no)],
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  partialReceive({ poId, items }) {
    const db = this.store.db;
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
    if (!po) return createResult({ status: ResultStatus.FAILURE, error: 'PO_NOT_FOUND' });
    if (po.status !== 'open') return createResult({ status: ResultStatus.FAILURE, error: `PO status is ${po.status}` });

    db.exec('BEGIN');
    try {
      const poItems = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(poId);
      const itemMap = new Map(poItems.map(it => [it.id, it]));

      let allFullyReceived = true;

      for (const incoming of items) {
        const poItem = itemMap.get(incoming.poItemId);
        if (!poItem) throw new Error(`PO item ${incoming.poItemId} not found on PO ${poId}`);

        const remaining = poItem.qty - poItem.received_qty;
        const receiveQty = Math.min(incoming.qty, remaining);
        if (receiveQty <= 0) continue;

        const newReceivedQty = poItem.received_qty + receiveQty;

        db.prepare('UPDATE purchase_order_items SET received_qty = ? WHERE id = ?').run(newReceivedQty, poItem.id);
        itemMap.set(poItem.id, { ...poItem, received_qty: newReceivedQty });

        const row = db.prepare('SELECT quantity FROM inventory WHERE product_id = ?').get(poItem.product_id);
        const newQty = (row?.quantity ?? 0) + receiveQty;
        if (row) {
          db.prepare("UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ?").run(newQty, poItem.product_id);
        } else {
          db.prepare('INSERT INTO inventory (product_id, quantity, reorder_level) VALUES (?, ?, 10)').run(poItem.product_id, newQty);
        }
        db.prepare("INSERT INTO inventory_movements (product_id, quantity, type, note) VALUES (?, ?, 'RECEIPT', ?)").run(
          poItem.product_id, receiveQty, `PO ${po.po_no} partial`
        );

        if (newReceivedQty < poItem.qty) allFullyReceived = false;
      }

      for (const [id, poItem] of itemMap) {
        if (poItem.received_qty < poItem.qty) {
          allFullyReceived = false;
          break;
        }
      }

      if (allFullyReceived) {
        db.prepare("UPDATE purchase_orders SET status = 'received' WHERE id = ?").run(poId);
      }

      db.exec('COMMIT');

      return createResult({
        data: { poId, partial: true, fullyReceived: allFullyReceived, status: allFullyReceived ? 'received' : 'open' },
        audit: [createAuditEntry(this.name, 'partial_receive', `${po.po_no} fully=${allFullyReceived}`)],
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  cancelPO({ poId }) {
    const db = this.store.db;
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
    if (!po) return createResult({ status: ResultStatus.FAILURE, error: 'PO_NOT_FOUND' });
    if (po.status !== 'open') return createResult({ status: ResultStatus.FAILURE, error: `Cannot cancel PO with status '${po.status}'` });

    db.prepare("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?").run(poId);

    return createResult({
      data: { poId, poNo: po.po_no, status: 'cancelled' },
      audit: [createAuditEntry(this.name, 'cancel_po', po.po_no)],
    });
  }

  listPOs() {
    const rows = this.store.db.prepare(
      `SELECT po.*, s.name AS supplier_name
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       ORDER BY po.created_at DESC`
    ).all();
    return createResult({
      data: rows,
      audit: [createAuditEntry(this.name, 'list_pos', `${rows.length} POs`)],
    });
  }

  getPO({ poId }) {
    const po = this.store.db.prepare(
      `SELECT po.*, s.name AS supplier_name
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       WHERE po.id = ?`
    ).get(poId);

    if (!po) {
      return createResult({ status: ResultStatus.FAILURE, error: 'PO_NOT_FOUND' });
    }

    const items = this.store.db.prepare(
      `SELECT poi.*, p.name AS product_name
       FROM purchase_order_items poi
       JOIN products p ON p.id = poi.product_id
       WHERE poi.po_id = ?`
    ).all(poId);

    return createResult({
      data: { ...po, items },
      audit: [createAuditEntry(this.name, 'get_po', `po=${poId}`)],
    });
  }

  listVendors() {
    const rows = this.store.db.prepare('SELECT * FROM suppliers ORDER BY name').all();
    return createResult({
      data: rows,
      audit: [createAuditEntry(this.name, 'list_vendors', `${rows.length} vendors`)],
    });
  }

  createVendor({ name, phone = null, email = null }) {
    const id = this.store.db.prepare(
      'INSERT INTO suppliers (name, phone, email) VALUES (?, ?, ?)'
    ).run(name, phone ?? null, email ?? null).lastInsertRowid;
    return createResult({
      data: { id, name },
      audit: [createAuditEntry(this.name, 'create_vendor', name)],
    });
  }

  evaluateVendor({ vendorId }) {
    const v = this.store.db.prepare('SELECT * FROM suppliers WHERE id = ?').get(vendorId);
    const pos = this.store.db.prepare(
      'SELECT COUNT(*) AS c, COALESCE(SUM(total_cents), 0) AS total FROM purchase_orders WHERE supplier_id = ?'
    ).get(vendorId);

    const avgCompletion = this.store.db.prepare(
      `SELECT AVG(CASE WHEN status = 'received' THEN 1.0 ELSE 0.0 END) AS completion_rate
       FROM purchase_orders WHERE supplier_id = ?`
    ).get(vendorId);

    return createResult({
      data: {
        vendor: v,
        totalOrders: pos.c,
        totalSpend: pos.total,
        completionRate: avgCompletion.completion_rate ?? 0,
        rating: pos.c === 0 ? 'N/A' : avgCompletion.completion_rate >= 0.9 ? 'A' : avgCompletion.completion_rate >= 0.7 ? 'B' : 'C',
      },
      audit: [createAuditEntry(this.name, 'evaluate_vendor', `vendor=${vendorId}`)],
    });
  }

  threeWayMatch({ poId, invoiceId }) {
    const db = this.store.db;
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
    if (!po) return createResult({ status: ResultStatus.FAILURE, error: 'PO_NOT_FOUND' });

    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) return createResult({ status: ResultStatus.FAILURE, error: 'INVOICE_NOT_FOUND' });

    const poItems = db.prepare(
      'SELECT poi.*, p.name AS product_name FROM purchase_order_items poi JOIN products p ON p.id = poi.product_id WHERE poi.po_id = ?'
    ).all(poId);

    const invItems = db.prepare(
      'SELECT ii.* FROM invoice_items ii WHERE ii.invoice_id = ?'
    ).all(invoiceId);

    const lineMatches = [];
    let allMatched = true;
    let totalDiscrepancy = 0;

    for (const poLine of poItems) {
      const invLine = invItems.find(il => il.product_id === poLine.product_id);
      if (!invLine) {
        lineMatches.push({
          productId: poLine.product_id,
          productName: poLine.product_name,
          poQty: poLine.qty,
          poUnitCost: poLine.unit_cost_cents,
          poLineTotal: poLine.line_total_cents,
          invoiceQty: 0,
          invoiceUnitCost: 0,
          invoiceLineTotal: 0,
          matched: false,
          discrepancy: -poLine.line_total_cents,
        });
        allMatched = false;
        totalDiscrepancy -= poLine.line_total_cents;
        continue;
      }

      const qtyMatch = poLine.qty === invLine.qty;
      const costMatch = poLine.unit_cost_cents === invLine.unit_price_cents;
      const totalMatch = poLine.line_total_cents === invLine.line_total_cents;
      const matched = qtyMatch && costMatch && totalMatch;
      const discrepancy = invLine.line_total_cents - poLine.line_total_cents;

      lineMatches.push({
        productId: poLine.product_id,
        productName: poLine.product_name,
        poQty: poLine.qty,
        poUnitCost: poLine.unit_cost_cents,
        poLineTotal: poLine.line_total_cents,
        invoiceQty: invLine.qty,
        invoiceUnitCost: invLine.unit_price_cents,
        invoiceLineTotal: invLine.line_total_cents,
        matched,
        discrepancy,
      });

      if (!matched) allMatched = false;
      totalDiscrepancy += discrepancy;
    }

    for (const invLine of invItems) {
      if (!poItems.find(pi => pi.product_id === invLine.product_id)) {
        allMatched = false;
        totalDiscrepancy += invLine.line_total_cents;
      }
    }

    return createResult({
      data: {
        poId,
        poNo: po.po_no,
        poTotal: po.total_cents,
        invoiceId,
        invoiceTotal: invoice.total_cents,
        allMatched,
        totalDiscrepancy,
        lineMatches,
      },
      audit: [createAuditEntry(this.name, '3way_match', allMatched ? 'MATCHED' : `MISMATCH discrepancy=${totalDiscrepancy}`)],
    });
  }
}

export { ProcurementAgent };
