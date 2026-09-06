// Retail catalog + inventory service, ported from graysale onto the shared
// products/inventory/tax_classes/product_categories tables.

import { badRequest, notFound, conflict, AppError } from './errors.js';
import { begin, tx } from './db.js';

const PRODUCT_SELECT = `
  SELECT p.*,
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
  LEFT JOIN tax_classes t ON t.id = p.tax_class_id`;

class CatalogService {
  constructor(db) {
    this.db = db;
  }

  // ── Products (superset shape shared with the main UI) ─────────────────

  listProducts({
    search = '',
    includeInactive = false,
    categoryId = null,
    lowOnly = false,
  } = {}) {
    const where = [];
    const params = [];

    if (!includeInactive) where.push('p.active = 1');
    if (search) {
      where.push('(LOWER(p.name) LIKE ? OR LOWER(p.sku) LIKE ? OR LOWER(p.barcode) LIKE ?)');
      params.push(`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`);
    }
    if (categoryId) {
      where.push('p.category_id = ?');
      params.push(categoryId);
    }
    if (lowOnly) {
      where.push('(COALESCE(i.quantity, 0) - COALESCE(i.qty_reserved, 0)) <= COALESCE(i.reorder_level, 0)');
    }

    return this.db.prepare(
      `${PRODUCT_SELECT}
       WHERE 1=1 ${where.length ? 'AND ' + where.join(' AND ') : ''}
       ORDER BY p.name ASC`
    ).all(...params);
  }

  getProduct(id) {
    return this.db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(id);
  }

  findByBarcode(barcode) {
    if (!barcode) return null;
    return this.db.prepare(`${PRODUCT_SELECT} WHERE p.barcode = ? LIMIT 1`).get(barcode);
  }

  findBySku(sku) {
    if (!sku) return null;
    return this.db.prepare(`${PRODUCT_SELECT} WHERE p.sku = ? AND p.active = 1 LIMIT 1`).get(sku);
  }

  // ── Inventory ─────────────────────────────────────────────────────────

  qtyOnHand(productId) {
    const row = this.db.prepare(
      'SELECT COALESCE(quantity, 0) AS qty_on_hand, COALESCE(qty_reserved, 0) AS qty_reserved FROM inventory WHERE product_id = ?'
    ).get(productId);
    return row ?? { qty_on_hand: 0, qty_reserved: 0 };
  }

  available(productId) {
    const s = this.qtyOnHand(productId);
    return s.qty_on_hand - s.qty_reserved;
  }

  // Stock movement. qty is signed (+ in, - out). Always tx'd.
  move({ productId, qty, type, note = '', refType = null, refId = null, userId = null }) {
    const q = Math.round(Number(qty) || 0);
    if (!productId || q === 0) throw badRequest('move: productId and non-zero qty required');

    return tx(this.db, (db) => {
      db.prepare('INSERT OR IGNORE INTO inventory (product_id, quantity, qty_reserved, reorder_level) VALUES (?, 0, 0, 0)')
        .run(productId);
      db.prepare('UPDATE inventory SET quantity = quantity + ?, updated_at = datetime(\'now\') WHERE product_id = ?')
        .run(q, productId);
      db.prepare(
        `INSERT INTO inventory_movements (product_id, quantity, type, note, ref_type, ref_id, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(productId, q, type, note, refType, refId, userId);
      return this.qtyOnHand(productId);
    });
  }

  reserve({ productId, qty, note = '', refType = null, refId = null, userId = null }) {
    const q = Math.round(Number(qty) || 0);
    if (q <= 0) throw badRequest('reserve: qty must be positive');
    return tx(this.db, (db) => {
      const row = db.prepare('SELECT COALESCE(quantity,0) - COALESCE(qty_reserved,0) AS avail FROM inventory WHERE product_id = ?').get(productId);
      if ((row?.avail ?? 0) < q) throw conflict('NOT_ENOUGH_STOCK');
      db.prepare('INSERT OR IGNORE INTO inventory (product_id, quantity, qty_reserved, reorder_level) VALUES (?, 0, 0, 0)').run(productId);
      db.prepare('UPDATE inventory SET qty_reserved = qty_reserved + ? WHERE product_id = ?').run(q, productId);
      db.prepare(
        `INSERT INTO inventory_movements (product_id, quantity, type, note, ref_type, ref_id, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(productId, -q, 'MOVE_OUT', note, refType, refId, userId);
      return this.available(productId);
    });
  }

  release({ productId, qty, note = '', refType = null, refId = null, userId = null }) {
    const q = Math.round(Number(qty) || 0);
    if (q <= 0) throw badRequest('release: qty must be positive');
    return tx(this.db, (db) => {
      db.prepare(
        'UPDATE inventory SET qty_reserved = MAX(COALESCE(qty_reserved, 0) - ?, 0) WHERE product_id = ?'
      ).run(q, productId);
      db.prepare(
        `INSERT INTO inventory_movements (product_id, quantity, type, note, ref_type, ref_id, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(productId, q, 'MOVE_IN', note, refType, refId, userId);
      return this.available(productId);
    });
  }

  movements({ productId = null, limit = 100 } = {}) {
    const where = productId ? 'WHERE im.product_id = ?' : 'WHERE 1=1';
    const params = productId ? [Number(productId), limit] : [limit];
    return this.db.prepare(
      `SELECT im.*, p.name AS product_name, p.sku
       FROM inventory_movements im
       JOIN products p ON p.id = im.product_id
       ${where}
       ORDER BY im.id DESC LIMIT ?`
    ).all(...params);
  }

  lowStock() {
    return this.listProducts({ lowOnly: true });
  }

  // ── Product CRUD ──────────────────────────────────────────────────────

  createProduct(body = {}) {
    const name = String(body.name ?? '').trim();
    if (!name) throw badRequest('Product name is required');
    const sku = String(body.sku ?? '').trim();
    const barcode = String(body.barcode ?? '').trim();

    const existing = this.db.prepare('SELECT id FROM products WHERE sku = ? AND sku != \'\'').get(sku);
    if (existing) throw conflict(`Product SKU already exists: ${sku}`);

    let category = String(body.category ?? '').trim();
    let categoryId = body.categoryId != null ? Number(body.categoryId) : (body.category_id != null ? Number(body.category_id) : null);
    if (categoryId) {
      const cat = this.db.prepare('SELECT * FROM product_categories WHERE id = ?').get(categoryId);
      if (cat) category = category || cat.name;
    }
    category = category || 'General';
    if (!categoryId) {
      const def = this.db.prepare('SELECT id FROM product_categories WHERE name = ?').get(category);
      categoryId = def?.id ?? 1;
    }

    let unit = String(body.unit ?? 'each').trim() || 'each';
    const costCents = Math.round(Number(body.costCents ?? body.cost_cents ?? 0) || 0);
    const priceCents = Math.round(Number(body.priceCents ?? body.price_cents ?? body.sellingPrice ?? 0) || 0);
    const serialTracked = (body.serialTracked ?? body.serial_tracked) ? 1 : 0;

    let taxClassId = body.taxClassId != null ? Number(body.taxClassId) : (body.tax_class_id != null ? Number(body.tax_class_id) : null);
    let taxRate = Number(body.taxRate ?? body.tax_rate ?? 0);
    if (taxClassId) {
      const tc = this.db.prepare('SELECT * FROM tax_classes WHERE id = ?').get(taxClassId);
      if (tc) {
        taxRate = tc.rate_bps / 10000;
      }
    }

    const reorderLevel = Math.round(Number(body.reorderLevel ?? body.reorder_level ?? 0) || 0);
    const quantity = Math.round(Number(body.quantity ?? 0) || 0);

    return tx(this.db, (db) => {
      const res = db.prepare(
        `INSERT INTO products (name, sku, barcode, category, category_id, unit, cost_cents, price_cents,
          tax_rate, tax_class_id, serial_tracked, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(name, sku, barcode, category, categoryId, unit, costCents, priceCents,
            taxRate, taxClassId, serialTracked, body.active === false ? 0 : 1);
      const productId = res.lastInsertRowid;
      db.prepare('INSERT INTO inventory (product_id, quantity, qty_reserved, reorder_level) VALUES (?, ?, 0, ?)')
        .run(productId, quantity, reorderLevel);
      return this.getProduct(productId);
    });
  }

  updateProduct(id, body = {}) {
    return tx(this.db, (db) => {
      const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      if (!p) throw notFound('Product not found');

      const fields = [];
      const params = [];

      const set = (col, val) => { fields.push(`${col} = ?`); params.push(val); };

      if (body.name !== undefined) set('name', String(body.name).trim() || p.name);
      if (body.sku !== undefined) set('sku', String(body.sku).trim() || p.sku);
      if (body.barcode !== undefined) set('barcode', String(body.barcode).trim() || null);
      if (body.unit !== undefined) set('unit', String(body.unit).trim() || 'each');
      if (body.category !== undefined) set('category', String(body.category).trim() || 'General');
      if (body.costCents !== undefined || body.cost_cents !== undefined) set('cost_cents', Math.round(Number(body.costCents ?? body.cost_cents) || 0));
      if (body.priceCents !== undefined || body.price_cents !== undefined || body.sellingPrice !== undefined) set('price_cents', Math.round(Number(body.priceCents ?? body.price_cents ?? body.sellingPrice) || 0));
      if (body.serialTracked !== undefined || body.serial_tracked !== undefined) set('serial_tracked', (body.serialTracked ?? body.serial_tracked) ? 1 : 0);
      if (body.active !== undefined) set('active', body.active ? 1 : 0);
      if (body.taxClassId !== undefined || body.tax_class_id !== undefined) {
        const tc = db.prepare('SELECT * FROM tax_classes WHERE id = ?').get(Number(body.taxClassId ?? body.tax_class_id));
        set('tax_class_id', tc?.id ?? null);
        if (tc) set('tax_rate', tc.rate_bps / 10000);
      } else if (body.taxRate !== undefined || body.tax_rate !== undefined) {
        const t = Math.round(Number(body.taxRate ?? body.tax_rate) * 10000);
        set('tax_rate', t / 10000);
        const tc = db.prepare('SELECT id FROM tax_classes WHERE rate_bps = ?').get(t);
        set('tax_class_id', tc?.id ?? null);
      }
      if (body.categoryId !== undefined || body.category_id !== undefined) {
        const cat = db.prepare('SELECT * FROM product_categories WHERE id = ?').get(Number(body.categoryId ?? body.category_id));
        set('category_id', cat?.id ?? null);
        if (cat && cat.name) set('category', cat.name);
      }

      if (fields.length) {
        db.prepare(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
      }
      if (body.reorderLevel !== undefined || body.reorder_level !== undefined) {
        db.prepare('INSERT OR IGNORE INTO inventory (product_id, quantity, qty_reserved, reorder_level) VALUES (?, 0, 0, 0)').run(id);
        db.prepare('UPDATE inventory SET reorder_level = ?, updated_at = datetime(\'now\') WHERE product_id = ?')
          .run(Math.round(Number(body.reorderLevel ?? body.reorder_level) || 0), id);
      }
      return this.getProduct(id);
    });
  }

  // ── Categories / tax classes ──────────────────────────────────────────

  categories() {
    return this.db.prepare('SELECT * FROM product_categories ORDER BY name ASC').all();
  }

  createCategory(name) {
    const n = String(name ?? '').trim();
    if (!n) throw badRequest('Category name required');
    const existing = this.db.prepare('SELECT id FROM product_categories WHERE name = ?').get(n);
    if (existing) throw conflict('Category already exists');
    const res = this.db.prepare('INSERT INTO product_categories (name) VALUES (?)').run(n);
    return this.db.prepare('SELECT * FROM product_categories WHERE id = ?').get(res.lastInsertRowid);
  }

  taxClasses() {
    return this.db.prepare('SELECT * FROM tax_classes ORDER BY rate_bps ASC').all();
  }
}

export { CatalogService, PRODUCT_SELECT };