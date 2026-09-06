import { createDb, migrate } from './db/database.js';

class Store {
  constructor(dbPath) {
    this.db = createDb(dbPath);
    migrate(this.db);
  }

  // ---------- Products & Catalog ----------
  // Superset shape shared with the retail UI: quantity/qty_on_hand/qty_reserved,
  // reorder_level, category_name, tax rate/class resolved from their tables.
  listProducts(activeOnly = true, { search = '', categoryId = null } = {}) {
    const where = [];
    const params = [];
    if (activeOnly) where.push('p.active = 1');
    if (search) {
      where.push('(LOWER(p.name) LIKE ? OR LOWER(p.sku) LIKE ? OR LOWER(p.barcode) LIKE ?)');
      const like = `%${String(search).toLowerCase()}%`;
      params.push(like, like, like);
    }
    if (categoryId) {
      where.push('p.category_id = ?');
      params.push(categoryId);
    }
    return this.db.prepare(
      `SELECT p.*,
              COALESCE(i.quantity, 0) AS quantity,
              COALESCE(i.quantity, 0) AS qty_on_hand,
              COALESCE(i.qty_reserved, 0) AS qty_reserved,
              COALESCE(i.reorder_level, 0) AS reorder_level,
              COALESCE(pc.name, p.category) AS category_name,
              COALESCE(t.name, '') AS tax_class_name,
              COALESCE(t.rate_bps, ROUND(p.tax_rate * 10000)) AS tax_rate_bps,
              COALESCE(t.id, p.tax_class_id) AS tax_class_id
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id
       LEFT JOIN product_categories pc ON pc.id = p.category_id
       LEFT JOIN tax_classes t ON t.id = p.tax_class_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY p.name ASC`
    ).all(...params);
  }

  findProductByBarcode(barcode) {
    return this.db.prepare(
      `SELECT p.*, i.quantity FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id
       WHERE p.barcode = ? AND p.active = 1`
    ).get(barcode);
  }

  createProduct({ sku, barcode, name, category, price_cents, cost_cents, tax_rate, quantity,
                  category_id, tax_class_id, unit, reorder_level, serial_tracked, active }) {
    const tx = this.db;
    tx.exec('BEGIN');
    try {
      const res = tx.prepare(
        `INSERT INTO products (sku, barcode, name, category, category_id, unit, price_cents, cost_cents, tax_rate, tax_class_id, serial_tracked, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(sku, barcode, name, category, category_id ?? null, unit ?? 'each',
            price_cents, cost_cents, tax_rate ?? 0.08, tax_class_id ?? null,
            serial_tracked ? 1 : 0, active === false ? 0 : 1);
      const id = res.lastInsertRowid;
      tx.prepare('INSERT INTO inventory (product_id, quantity, reorder_level) VALUES (?, ?, ?)')
        .run(id, quantity ?? 0, reorder_level ?? 10);
      tx.exec('COMMIT');
      return id;
    } catch (e) {
      tx.exec('ROLLBACK');
      throw e;
    }
  }

  updateProduct(id, fields) {
    const allowed = ['sku', 'barcode', 'name', 'category', 'category_id', 'unit',
                     'price_cents', 'cost_cents', 'tax_rate', 'tax_class_id',
                     'serial_tracked', 'active'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  // ---------- Inventory ----------
  getStock(productId) {
    return this.db.prepare('SELECT quantity FROM inventory WHERE product_id = ?').get(productId);
  }

  adjustInventory(productId, delta, type, note = '') {
    const tx = this.db;
    tx.exec('BEGIN');
    try {
      const row = tx.prepare('SELECT quantity FROM inventory WHERE product_id = ?').get(productId);
      const newQty = (row?.quantity ?? 0) + delta;
      if (newQty < 0) { tx.exec('ROLLBACK'); throw new Error('NEGATIVE_STOCK: quantity cannot go below zero'); }
      if (row) {
        tx.prepare('UPDATE inventory SET quantity = ?, updated_at = datetime(\'now\') WHERE product_id = ?')
          .run(newQty, productId);
      } else {
        tx.prepare('INSERT INTO inventory (product_id, quantity, reorder_level) VALUES (?, ?, 0)')
          .run(productId, newQty);
      }
      tx.prepare('INSERT INTO inventory_movements (product_id, quantity, type, note) VALUES (?, ?, ?, ?)')
        .run(productId, delta, type, note);
      tx.exec('COMMIT');
      return newQty;
    } catch (e) {
      tx.exec('ROLLBACK');
      throw e;
    }
  }

  listLowStock() {
    return this.db.prepare(
      `SELECT p.*,
              COALESCE(i.quantity, 0) AS quantity,
              COALESCE(i.quantity, 0) AS qty_on_hand,
              COALESCE(i.qty_reserved, 0) AS qty_reserved,
              COALESCE(i.reorder_level, 0) AS reorder_level,
              COALESCE(pc.name, p.category) AS category_name
       FROM products p JOIN inventory i ON i.product_id = p.id
       LEFT JOIN product_categories pc ON pc.id = p.category_id
       WHERE p.active = 1 AND (COALESCE(i.quantity,0) - COALESCE(i.qty_reserved,0)) <= COALESCE(i.reorder_level,0)
       ORDER BY i.quantity ASC`
    ).all();
  }

  updateInventoryReorder(productId, reorderLevel) {
    this.db.prepare('UPDATE inventory SET reorder_level = ?, updated_at = datetime(\'now\') WHERE product_id = ?')
      .run(reorderLevel, productId);
  }

  // ---------- Customers & Loyalty ----------
  listCustomers() {
    return this.db.prepare('SELECT * FROM customers ORDER BY name').all();
  }

  findCustomer(query) {
    const like = `%${query}%`;
    return this.db.prepare(
      `SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? OR email LIKE ? LIMIT 20`
    ).all(like, like, like);
  }

  createCustomer({ name, phone, email }) {
    return this.db.prepare('INSERT INTO customers (name, phone, email) VALUES (?, ?, ?)')
      .run(name, phone, email).lastInsertRowid;
  }

  updateCustomer(id, fields) {
    const allowed = ['name', 'phone', 'email'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  deleteCustomer(id) {
    this.db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  }

  // earning is 1 point per full dollar spent (100 cents)
  // redemption is 100 points = $1 off
  pointsForCents(cents) { return Math.floor(cents / 100); }
  centsForPoints(points) { return Math.floor(points / 100) * 100; }
}

export { Store };
