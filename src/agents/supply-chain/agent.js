import { Agent } from '../agent.js';
import { createResult, createAuditEntry, ResultStatus } from '../message.js';

class SupplyChainAgent extends Agent {
  constructor(store) {
    super({
      name: 'SCM_AGENT',
      role: 'Supply Chain — Inventory, Warehouse, Logistics',
      capabilities: [
        'inventory.check', 'inventory.adjust', 'inventory.movements', 'inventory.low_stock',
        'warehouse.stock_level', 'warehouse.transfer',
        'logistics.track', 'logistics.create',
      ],
    });
    this.store = store;
  }

  async handle(message) {
    const { domain, payload } = message;
    const action = domain.split('.').slice(1).join('.');

    switch (action) {
      case 'check': return this.checkStock(payload);
      case 'adjust': return this.adjustInventory(payload);
      case 'movements': return this.getMovements(payload);
      case 'low_stock': return this.lowStock();
      case 'stock_level': return this.stockLevel(payload);
      case 'transfer': return this.transferStock(payload);
      case 'track': return this.trackShipment(payload);
      case 'create': return this.createShipment(payload);
      case 'update': return this.updateShipmentStatus(payload);
      case 'list_shipments': return this.listShipments(payload);
      default: return createResult({ status: ResultStatus.FAILURE, error: `Unknown SCM action: ${action}` });
    }
  }

  checkStock({ productId }) {
    const row = this.store.db.prepare(
      `SELECT p.id, p.name, p.sku, i.quantity, i.reorder_level, i.location
       FROM products p LEFT JOIN inventory i ON i.product_id = p.id WHERE p.id = ?`
    ).get(productId);
    return createResult({
      data: row || null,
      audit: [createAuditEntry(this.name, 'check_stock', `product=${productId}`)],
    });
  }

  adjustInventory({ productId, delta, type = 'ADJUST', note = '' }) {
    const db = this.store.db;
    db.exec('BEGIN');
    try {
      const row = db.prepare('SELECT quantity FROM inventory WHERE product_id = ?').get(productId);
      const newQty = (row?.quantity ?? 0) + delta;
      if (newQty < 0) {
        db.exec('ROLLBACK');
        return createResult({ status: ResultStatus.FAILURE, error: 'NEGATIVE_STOCK' });
      }
      if (row) {
        db.prepare("UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ?").run(newQty, productId);
      } else {
        db.prepare('INSERT INTO inventory (product_id, quantity, reorder_level) VALUES (?, ?, 0)').run(productId, newQty);
      }
      db.prepare('INSERT INTO inventory_movements (product_id, quantity, type, note) VALUES (?, ?, ?, ?)').run(productId, delta, type, note);
      db.exec('COMMIT');
      return createResult({
        data: { productId, quantity: newQty },
        audit: [createAuditEntry(this.name, 'adjust_inventory', `product=${productId} delta=${delta}`)],
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  getMovements({ productId }) {
    const db = this.store.db;
    const rows = productId
      ? db.prepare(
          'SELECT im.*, p.name AS product_name FROM inventory_movements im JOIN products p ON p.id = im.product_id WHERE im.product_id = ? ORDER BY im.created_at DESC'
        ).all(productId)
      : db.prepare(
          'SELECT im.*, p.name AS product_name FROM inventory_movements im JOIN products p ON p.id = im.product_id ORDER BY im.created_at DESC LIMIT 200'
        ).all();
    return createResult({
      data: rows,
      audit: [createAuditEntry(this.name, 'get_movements', `${rows.length} records`)],
    });
  }

  lowStock() {
    const rows = this.store.db.prepare(
      `SELECT p.id, p.name, p.sku, i.quantity, i.reorder_level
       FROM products p JOIN inventory i ON i.product_id = p.id
       WHERE i.quantity <= i.reorder_level AND p.active = 1 ORDER BY i.quantity ASC`
    ).all();
    return createResult({
      data: rows,
      audit: [createAuditEntry(this.name, 'low_stock', `${rows.length} items below reorder`)],
    });
  }

  stockLevel({ productId }) {
    const row = this.store.db.prepare('SELECT quantity FROM inventory WHERE product_id = ?').get(productId);
    return createResult({
      data: { productId, quantity: row?.quantity ?? 0 },
      audit: [createAuditEntry(this.name, 'stock_level', `product=${productId}`)],
    });
  }

  transferStock({ fromProductId, toProductId, quantity, note }) {
    const db = this.store.db;
    db.exec('BEGIN');
    try {
      const fromRow = db.prepare('SELECT quantity FROM inventory WHERE product_id = ?').get(fromProductId);
      const fromQty = (fromRow?.quantity ?? 0) - quantity;
      if (fromQty < 0) {
        db.exec('ROLLBACK');
        return createResult({ status: ResultStatus.FAILURE, error: 'NEGATIVE_STOCK' });
      }

      db.prepare("UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ?").run(fromQty, fromProductId);
      db.prepare("INSERT INTO inventory_movements (product_id, quantity, type, note) VALUES (?, ?, 'TRANSFER_OUT', ?)").run(
        fromProductId, -quantity, note || `Transfer out to product ${toProductId}`
      );

      const toRow = db.prepare('SELECT quantity FROM inventory WHERE product_id = ?').get(toProductId);
      const toQty = (toRow?.quantity ?? 0) + quantity;
      if (toRow) {
        db.prepare("UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ?").run(toQty, toProductId);
      } else {
        db.prepare('INSERT INTO inventory (product_id, quantity, reorder_level) VALUES (?, ?, 10)').run(toProductId, toQty);
      }
      db.prepare("INSERT INTO inventory_movements (product_id, quantity, type, note) VALUES (?, ?, 'TRANSFER_IN', ?)").run(
        toProductId, quantity, note || `Transfer in from product ${fromProductId}`
      );

      db.exec('COMMIT');
      return createResult({
        data: { from: fromProductId, to: toProductId, quantity },
        audit: [createAuditEntry(this.name, 'transfer_stock', `${quantity} from ${fromProductId} to ${toProductId}`)],
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  trackShipment({ trackingNo }) {
    const row = this.store.db.prepare(
      `SELECT s.*, po.po_no, sp.name AS supplier_name
       FROM shipments s
       LEFT JOIN purchase_orders po ON po.id = s.po_id
       LEFT JOIN suppliers sp ON sp.id = s.supplier_id
       WHERE s.tracking_no = ?`
    ).get(trackingNo);

    if (!row) {
      return createResult({ status: ResultStatus.FAILURE, error: 'SHIPMENT_NOT_FOUND' });
    }

    return createResult({
      data: row,
      audit: [createAuditEntry(this.name, 'track_shipment', trackingNo)],
    });
  }

  createShipment({ poId, supplierId, carrier, estimatedArrival }) {
    const db = this.store.db;
    const trackingNo = `SHP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    const res = db.prepare(
      `INSERT INTO shipments (tracking_no, po_id, supplier_id, carrier, estimated_arrival)
       VALUES (?, ?, ?, ?, ?)`
    ).run(trackingNo, poId ?? null, supplierId ?? null, carrier ?? null, estimatedArrival ?? null);

    const shipment = db.prepare('SELECT * FROM shipments WHERE id = ?').get(res.lastInsertRowid);

    return createResult({
      data: shipment,
      audit: [createAuditEntry(this.name, 'create_shipment', trackingNo)],
    });
  }

  updateShipmentStatus({ trackingNo, status, actualArrival }) {
    const db = this.store.db;
    const existing = db.prepare('SELECT * FROM shipments WHERE tracking_no = ?').get(trackingNo);
    if (!existing) {
      return createResult({ status: ResultStatus.FAILURE, error: 'SHIPMENT_NOT_FOUND' });
    }

    const sets = ['status = ?'];
    const vals = [status];

    if (actualArrival) {
      sets.push('actual_arrival = ?');
      vals.push(actualArrival);
    }

    vals.push(trackingNo);
    db.prepare(`UPDATE shipments SET ${sets.join(', ')} WHERE tracking_no = ?`).run(...vals);

    const updated = db.prepare('SELECT * FROM shipments WHERE tracking_no = ?').get(trackingNo);

    return createResult({
      data: updated,
      audit: [createAuditEntry(this.name, 'update_shipment_status', `${trackingNo} -> ${status}`)],
    });
  }

  listShipments({ status } = {}) {
    const db = this.store.db;
    let rows;
    if (status) {
      rows = db.prepare(
        `SELECT s.*, po.po_no, sp.name AS supplier_name
         FROM shipments s
         LEFT JOIN purchase_orders po ON po.id = s.po_id
         LEFT JOIN suppliers sp ON sp.id = s.supplier_id
         WHERE s.status = ?
         ORDER BY s.created_at DESC`
      ).all(status);
    } else {
      rows = db.prepare(
        `SELECT s.*, po.po_no, sp.name AS supplier_name
         FROM shipments s
         LEFT JOIN purchase_orders po ON po.id = s.po_id
         LEFT JOIN suppliers sp ON sp.id = s.supplier_id
         ORDER BY s.created_at DESC`
      ).all();
    }

    return createResult({
      data: rows,
      audit: [createAuditEntry(this.name, 'list_shipments', `${rows.length} shipments`)],
    });
  }
}

export { SupplyChainAgent };
