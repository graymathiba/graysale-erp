import { badRequest, conflict, notFound } from '../lib/errors.js';
import { tx } from '../db/database.js';
import { resolveTenantId } from '../lib/tenant.js';

const productRow = `
SELECT p.*, c.name AS category_name, t.name AS tax_class_name, t.rate_bps AS tax_rate_bps,
       COALESCE(s.qty_on_hand, 0) AS qty_on_hand, COALESCE(s.qty_reserved, 0) AS qty_reserved
FROM products p
LEFT JOIN product_categories c ON c.id = p.category_id
LEFT JOIN tax_classes t ON t.id = p.tax_class_id
LEFT JOIN product_stock s ON s.product_id = p.id`;

export class CatalogService {
  constructor(db, auth) {
    this.db = db;
    this.auth = auth;
  }

  // ---------- products ----------
  listProducts({ search, includeInactive = false, categoryId, lowOnly = false, tenantId } = {}) {
    const tenant = resolveTenantId(this.db, tenantId);
    const where = ['p.tenant_id = ?'];
    const vals = [tenant];
    if (!includeInactive) {
      where.push('p.active = 1');
    }
    if (categoryId) {
      where.push('p.category_id = ?');
      vals.push(categoryId);
    }
    if (search) {
      where.push(
        '(p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ? OR p.brand LIKE ? OR p.manufacturer_part_no LIKE ? OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.product_id = p.id AND pb.barcode = ?))',
      );
      const q = `%${search}%`;
      vals.push(q, q, q, q, q, q);
    }
    if (lowOnly) {
      where.push('(COALESCE(s.qty_on_hand,0) - COALESCE(s.qty_reserved,0)) <= p.reorder_level');
    }
    const sql = `${productRow} WHERE ${where.join(' AND ')} ORDER BY p.name`;
    const rows = this.db.prepare(sql).all(...vals);
    // Attach tiered prices, barcodes, batch summary, UOM, bundle flag
    for (const p of rows) {
      p.tiers = this.priceTiers(p.id);
      p.barcodes = this.barcodes(p.id);
      p.batches = this.batches(p.id);
      p.uom = this.uomList(p.id);
      p.is_bundle =
        this.db.prepare('SELECT 1 FROM product_bundles WHERE bundle_product_id = ? LIMIT 1').get(p.id) != null;
    }
    return rows;
  }

  getProduct(id, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const p = this.db.prepare(`${productRow} WHERE p.id = ? AND p.tenant_id = ?`).get(Number(id), tenant);
    if (!p) throw notFound('PRODUCT_NOT_FOUND');
    p.tiers = this.priceTiers(id);
    p.barcodes = this.barcodes(id);
    p.batches = this.batches(id);
    p.uom = this.uomList(id);
    p.bundle_components = this.bundleComponents(id);
    p.is_bundle = p.bundle_components.length > 0;
    return p;
  }

  findByBarcode(barcode, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const p = this.db
      .prepare(`${productRow} WHERE p.barcode = ? AND p.active = 1 AND p.tenant_id = ?`)
      .get(barcode, tenant);
    if (p) return p;
    // Fall back to product_barcodes table
    const pb = this.db
      .prepare(
        'SELECT pb.product_id FROM product_barcodes pb JOIN products p ON p.id = pb.product_id WHERE pb.barcode = ? AND pb.active = 1 AND p.tenant_id = ?',
      )
      .get(barcode, tenant);
    return pb ? this.db.prepare(`${productRow} WHERE p.id = ? AND p.tenant_id = ?`).get(pb.product_id, tenant) : null;
  }

  findBySku(sku, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const p = this.db.prepare(`${productRow} WHERE p.sku = ? AND p.active = 1 AND p.tenant_id = ?`).get(sku, tenant);
    return p || null;
  }

  resolveProduct(ref, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    let p = null;
    if (Number.isInteger(ref) || /^\d+$/.test(String(ref))) {
      p = this.db.prepare(`${productRow} WHERE p.id = ? AND p.tenant_id = ?`).get(Number(ref), tenant);
    }
    if (!p) {
      p = this.findByBarcode(String(ref).trim(), tenant) || this.findBySku(String(ref).trim(), tenant);
    }
    if (!p) throw notFound(`PRODUCT_NOT_FOUND: ${ref}`);
    p.tiers = this.priceTiers(p.id);
    p.uom = this.uomList(p.id);
    const components = this.bundleComponents(p.id);
    p.bundle_components = components;
    p.is_bundle = components.length > 0;
    return p;
  }

  resolvePrice(product, qty = 1, tierName = null) {
    if (tierName && product.tiers) {
      const tier = product.tiers.find((t) => t.tier_name === tierName && t.active && qty >= t.min_qty);
      if (tier) return tier.price_cents;
    }
    if (product.tiers) {
      // Auto-select best applicable tier (highest min_qty that fits)
      const applicable = product.tiers
        .filter((t) => t.active && qty >= t.min_qty)
        .sort((a, b) => b.min_qty - a.min_qty);
      if (applicable.length) return applicable[0].price_cents;
    }
    return product.price_cents;
  }

  createProduct(body, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    if (!body.name) throw badRequest('PRODUCT_NAME_REQUIRED');
    if (!body.sku) throw badRequest('SKU_REQUIRED');
    if (this.db.prepare('SELECT id FROM products WHERE sku = ? AND tenant_id = ?').get(body.sku, tenant))
      throw conflict(`SKU_EXISTS: ${body.sku}`);
    if (
      body.barcode &&
      this.db.prepare('SELECT id FROM products WHERE barcode = ? AND tenant_id = ?').get(body.barcode, tenant)
    ) {
      throw conflict(`BARCODE_EXISTS: ${body.barcode}`);
    }
    const info = tx(this.db, () => {
      const info = this.db
        .prepare(
          `
        INSERT INTO products (sku, barcode, name, category_id, unit, cost_cents, price_cents, tax_class_id,
          reorder_level, serial_tracked, active, description, brand, manufacturer_part_no, hs_code, bin_location,
          min_stock, max_stock, lead_time_days, warranty_days, weight_grams, length_mm, width_mm, height_mm, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          body.sku,
          body.barcode || null,
          body.name,
          body.categoryId || null,
          body.unit || 'each',
          Math.round(Number(body.costCents ?? body.cost ?? 0)),
          Math.round(Number(body.priceCents ?? body.price ?? 0)),
          body.taxClassId ?? 2,
          Math.round(Number(body.reorderLevel ?? 0)),
          body.serialTracked ? 1 : 0,
          body.active === false || body.active === 0 ? 0 : 1,
          body.description || '',
          body.brand || '',
          body.manufacturerPartNo || '',
          body.hsCode || '',
          body.binLocation || '',
          Math.round(Number(body.minStock ?? 0)),
          Math.round(Number(body.maxStock ?? 0)),
          Math.round(Number(body.leadTimeDays ?? 0)),
          Math.round(Number(body.warrantyDays ?? 0)),
          Math.round(Number(body.weightGrams ?? 0)),
          Math.round(Number(body.lengthMm ?? 0)),
          Math.round(Number(body.widthMm ?? 0)),
          Math.round(Number(body.heightMm ?? 0)),
          tenant,
        );
      const pid = info.lastInsertRowid;
      this.db.prepare('INSERT INTO product_stock (product_id, qty_on_hand, qty_reserved) VALUES (?, 0, 0)').run(pid);
      // Seed tiered prices if provided
      if (Array.isArray(body.tiers)) {
        for (const t of body.tiers) {
          if (t.tierName && t.priceCents != null) {
            this.db
              .prepare(
                'INSERT OR IGNORE INTO product_price_tiers (product_id, tier_name, price_cents, min_qty) VALUES (?, ?, ?, ?)',
              )
              .run(pid, t.tierName, Math.round(Number(t.priceCents)), Math.round(Number(t.minQty ?? 1)));
          }
        }
      }
      // Seed barcodes if provided
      if (Array.isArray(body.barcodes)) {
        for (const b of body.barcodes) {
          if (b.barcode) {
            this.db
              .prepare(
                'INSERT OR IGNORE INTO product_barcodes (product_id, barcode, format, is_primary) VALUES (?, ?, ?, ?)',
              )
              .run(pid, b.barcode, b.format || 'CODE128', b.isPrimary ? 1 : 0);
          }
        }
      }
      // Seed UOM conversions if provided
      if (Array.isArray(body.uom)) {
        for (const u of body.uom) {
          if (u.uomName) {
            this.db
              .prepare(
                'INSERT INTO product_uom (product_id, uom_name, conversion_factor, is_base, price_override_cents) VALUES (?, ?, ?, ?, ?)',
              )
              .run(
                pid,
                u.uomName,
                Number(u.conversionFactor ?? 1),
                u.isBase ? 1 : 0,
                u.priceOverrideCents != null ? Math.round(Number(u.priceOverrideCents)) : null,
              );
          }
        }
      }
      // Seed bundle components if provided (ID or SKU, same as update)
      if (Array.isArray(body.bundleComponents)) {
        for (const c of body.bundleComponents) {
          if (!c.componentProductId) continue;
          const comp =
            this.db
              .prepare('SELECT id FROM products WHERE id = ? AND tenant_id = ?')
              .get(Number(c.componentProductId), tenant) ||
            this.db
              .prepare('SELECT id FROM products WHERE sku = ? AND tenant_id = ?')
              .get(String(c.componentProductId).trim(), tenant);
          if (!comp) continue;
          this.db
            .prepare(
              'INSERT INTO product_bundles (bundle_product_id, component_product_id, qty_required) VALUES (?, ?, ?)',
            )
            .run(pid, comp.id, Math.round(Number(c.qtyRequired ?? 1)));
        }
      }
      this.auth.audit(body.userId, body.username, 'PRODUCT_CREATE', 'product', pid, body.name);
      return pid;
    });
    return this.getProduct(info, tenant);
  }

  updateProduct(id, body, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const sets = [];
    const vals = [];
    const map = {
      sku: 'sku',
      barcode: 'barcode',
      name: 'name',
      unit: 'unit',
      categoryId: 'category_id',
      costCents: 'cost_cents',
      priceCents: 'price_cents',
      taxClassId: 'tax_class_id',
      reorderLevel: 'reorder_level',
      serialTracked: 'serial_tracked',
      active: 'active',
      description: 'description',
      brand: 'brand',
      manufacturerPartNo: 'manufacturer_part_no',
      hsCode: 'hs_code',
      binLocation: 'bin_location',
      minStock: 'min_stock',
      maxStock: 'max_stock',
      leadTimeDays: 'lead_time_days',
      warrantyDays: 'warranty_days',
      weightGrams: 'weight_grams',
      lengthMm: 'length_mm',
      widthMm: 'width_mm',
      heightMm: 'height_mm',
    };
    const numeric = new Set([
      'category_id',
      'tax_class_id',
      'cost_cents',
      'price_cents',
      'reorder_level',
      'min_stock',
      'max_stock',
      'lead_time_days',
      'warranty_days',
      'weight_grams',
      'length_mm',
      'width_mm',
      'height_mm',
    ]);
    for (const [key, col] of Object.entries(map)) {
      if (body[key] !== undefined) {
        // Empty strings are "unset" references (e.g. no category chosen) — null them
        // so nullable FK columns don't hit SQLite FOREIGN KEY constraint failures.
        const v = body[key];
        let bound;
        if (v === '') {
          bound = null;
        } else if (typeof v === 'boolean') {
          // node:sqlite refuses booleans outright; store as 0/1.
          bound = v ? 1 : 0;
        } else if (numeric.has(col)) {
          const n = Number(v);
          bound = Number.isFinite(n) ? Math.round(n) : v;
        } else {
          bound = v;
        }
        (sets.push(`${col} = ?`), vals.push(bound));
      }
    }
    if (
      !sets.length &&
      !Array.isArray(body.tiers) &&
      !Array.isArray(body.barcodes) &&
      !Array.isArray(body.uom) &&
      !Array.isArray(body.bundleComponents)
    )
      return;
    if (sets.length) {
      vals.push(Number(id), tenant);
      this.db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...vals);
    }
    // Replace tiered prices
    if (Array.isArray(body.tiers)) {
      this.db.prepare('DELETE FROM product_price_tiers WHERE product_id = ?').run(id);
      for (const t of body.tiers) {
        if (t.tierName && t.priceCents != null) {
          this.db
            .prepare(
              'INSERT INTO product_price_tiers (product_id, tier_name, price_cents, min_qty) VALUES (?, ?, ?, ?)',
            )
            .run(id, t.tierName, Math.round(Number(t.priceCents)), Math.round(Number(t.minQty ?? 1)));
        }
      }
    }
    // Replace barcodes
    if (Array.isArray(body.barcodes)) {
      this.db.prepare('DELETE FROM product_barcodes WHERE product_id = ?').run(id);
      for (const b of body.barcodes) {
        if (b.barcode) {
          this.db
            .prepare(
              'INSERT OR IGNORE INTO product_barcodes (product_id, barcode, format, is_primary) VALUES (?, ?, ?, ?)',
            )
            .run(id, b.barcode, b.format || 'CODE128', b.isPrimary ? 1 : 0);
        }
      }
    }
    // Replace UOM
    if (Array.isArray(body.uom)) {
      this.db.prepare('DELETE FROM product_uom WHERE product_id = ?').run(id);
      for (const u of body.uom) {
        if (u.uomName) {
          this.db
            .prepare(
              'INSERT INTO product_uom (product_id, uom_name, conversion_factor, is_base, price_override_cents) VALUES (?, ?, ?, ?, ?)',
            )
            .run(
              id,
              u.uomName,
              Number(u.conversionFactor ?? 1),
              u.isBase ? 1 : 0,
              u.priceOverrideCents != null ? Math.round(Number(u.priceOverrideCents)) : null,
            );
        }
      }
    }
    // Replace bundle components
    if (Array.isArray(body.bundleComponents)) {
      this.db.prepare('DELETE FROM product_bundles WHERE bundle_product_id = ?').run(id);
      for (const c of body.bundleComponents) {
        if (c.componentProductId) {
          const comp =
            this.db
              .prepare('SELECT id FROM products WHERE id = ? AND tenant_id = ?')
              .get(Number(c.componentProductId), tenant) ||
            this.db
              .prepare('SELECT id FROM products WHERE sku = ? AND tenant_id = ?')
              .get(String(c.componentProductId).trim(), tenant);
          if (!comp) continue;
          this.db
            .prepare(
              'INSERT INTO product_bundles (bundle_product_id, component_product_id, qty_required) VALUES (?, ?, ?)',
            )
            .run(id, comp.id, Math.round(Number(c.qtyRequired ?? 1)));
        }
      }
    }
    return this.getProduct(id, tenant);
  }

  // ---------- stock movements ----------
  move({ productId, qty, type, refType, refId, note, userId, batchNo, tenantId }) {
    if (!Number.isInteger(qty) || qty === 0) throw badRequest('QTY_MUST_BE_NONZERO_INTEGER');
    const tenant = resolveTenantId(this.db, tenantId);
    const exists = this.db.prepare('SELECT id FROM products WHERE id = ? AND tenant_id = ?').get(productId, tenant);
    if (!exists) throw notFound('PRODUCT_NOT_FOUND');
    return tx(this.db, () => {
      this.db
        .prepare(
          `
        INSERT INTO product_stock (product_id, qty_on_hand)
        VALUES (?, ?)
        ON CONFLICT(product_id) DO UPDATE SET qty_on_hand = qty_on_hand + excluded.qty_on_hand
      `,
        )
        .run(productId, qty);
      // Also decrement batch stock if batch_no provided and stock is moving out
      if (batchNo && qty < 0) {
        const b = this.db
          .prepare('SELECT id, qty_on_hand FROM product_batches WHERE product_id = ? AND batch_no = ?')
          .get(productId, batchNo);
        if (!b) throw notFound(`BATCH_NOT_FOUND: ${batchNo}`);
        if (b.qty_on_hand + qty < 0) throw badRequest(`BATCH_INSUFFICIENT_STOCK: ${batchNo}`);
        this.db.prepare('UPDATE product_batches SET qty_on_hand = qty_on_hand + ? WHERE id = ?').run(qty, b.id);
      }
      this.db
        .prepare(
          'INSERT INTO stock_movements (product_id, qty, type, ref_type, ref_id, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(productId, qty, type, refType ?? null, refId ?? null, note ?? '', userId ?? null);
      return this.qtyOnHand(productId);
    });
  }

  qtyOnHand(productId) {
    const r = this.db
      .prepare('SELECT qty_on_hand, qty_reserved FROM product_stock WHERE product_id = ?')
      .get(productId);
    return r || { qty_on_hand: 0, qty_reserved: 0 };
  }

  // net available = on_hand - reserved (layaways hold units)
  available(productId) {
    const r = this.qtyOnHand(productId);
    return r.qty_on_hand - r.qty_reserved;
  }

  movements({ productId, limit = 200 }) {
    if (productId) {
      return this.db
        .prepare('SELECT * FROM stock_movements WHERE product_id = ? ORDER BY id DESC LIMIT ?')
        .all(productId, limit);
    }
    return this.db.prepare('SELECT * FROM stock_movements ORDER BY id DESC LIMIT ?').all(limit);
  }

  reserve(productId, qty, refType, refId) {
    if (!Number.isInteger(qty) || qty <= 0) throw badRequest('QTY_MUST_BE_POSITIVE_INTEGER');
    this.db
      .prepare(
        `
      INSERT INTO product_stock (product_id, qty_reserved)
      VALUES (?, ?)
      ON CONFLICT(product_id) DO UPDATE SET qty_reserved = qty_reserved + excluded.qty_reserved
    `,
      )
      .run(productId, qty);
    this.db
      .prepare(
        'INSERT INTO stock_movements (product_id, qty, type, ref_type, ref_id, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(productId, -qty, 'MOVE_OUT', refType, refId, 'reserved (layaway)', null);
  }

  release(productId, qty, refType, refId) {
    this.db
      .prepare(
        `
      UPDATE product_stock SET qty_reserved = MAX(0, qty_reserved - ?) WHERE product_id = ?
    `,
      )
      .run(qty, productId);
    this.db
      .prepare(
        'INSERT INTO stock_movements (product_id, qty, type, ref_type, ref_id, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(productId, qty, 'MOVE_OUT', refType, refId, 'released (layaway)', null);
  }

  lowStock() {
    return this.listProducts({ lowOnly: true });
  }

  // ---------- barcodes ----------
  barcodes(productId) {
    return this.db
      .prepare('SELECT * FROM product_barcodes WHERE product_id = ? ORDER BY is_primary DESC, id')
      .all(productId);
  }

  addBarcode(productId, barcode, format = 'CODE128', isPrimary = false) {
    if (!barcode) throw badRequest('BARCODE_REQUIRED');
    const exists = this.db.prepare('SELECT id FROM product_barcodes WHERE barcode = ?').get(barcode);
    if (exists) throw conflict(`BARCODE_EXISTS: ${barcode}`);
    const pExists = this.db.prepare('SELECT id FROM products WHERE barcode = ?').get(barcode);
    if (pExists) throw conflict(`BARCODE_EXISTS: ${barcode}`);
    if (isPrimary) this.db.prepare('UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ?').run(productId);
    return this.db
      .prepare('INSERT INTO product_barcodes (product_id, barcode, format, is_primary) VALUES (?, ?, ?, ?)')
      .run(productId, barcode, format, isPrimary ? 1 : 0).lastInsertRowid;
  }

  removeBarcode(id) {
    this.db.prepare('DELETE FROM product_barcodes WHERE id = ?').run(id);
  }

  // ---------- price tiers ----------
  priceTiers(productId) {
    return this.db.prepare('SELECT * FROM product_price_tiers WHERE product_id = ? ORDER BY min_qty').all(productId);
  }

  setPriceTiers(productId, tiers) {
    this.db.prepare('DELETE FROM product_price_tiers WHERE product_id = ?').run(productId);
    for (const t of tiers) {
      if (t.tierName && t.priceCents != null) {
        this.db
          .prepare('INSERT INTO product_price_tiers (product_id, tier_name, price_cents, min_qty) VALUES (?, ?, ?, ?)')
          .run(productId, t.tierName, Math.round(Number(t.priceCents)), Math.round(Number(t.minQty ?? 1)));
      }
    }
    return this.priceTiers(productId);
  }

  // ---------- batches ----------
  batches(productId) {
    return this.db
      .prepare(
        'SELECT * FROM product_batches WHERE product_id = ? AND active = 1 ORDER BY expiry_date ASC NULLS LAST, id',
      )
      .all(productId);
  }

  addBatch(productId, { batchNo, manufactureDate, expiryDate, qtyOnHand, location }) {
    if (!batchNo) throw badRequest('BATCH_NO_REQUIRED');
    try {
      return this.db
        .prepare(
          'INSERT INTO product_batches (product_id, batch_no, manufacture_date, expiry_date, qty_on_hand, location) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          productId,
          batchNo,
          manufactureDate || null,
          expiryDate || null,
          Math.round(Number(qtyOnHand ?? 0)),
          location || '',
        ).lastInsertRowid;
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw conflict(`BATCH_EXISTS: ${batchNo}`);
      throw e;
    }
  }

  allocateBatch(productId, batchNo, qty) {
    if (!Number.isInteger(qty) || qty <= 0) throw badRequest('QTY_MUST_BE_POSITIVE_INTEGER');
    const b = this.db
      .prepare('SELECT * FROM product_batches WHERE product_id = ? AND batch_no = ? AND active = 1')
      .get(productId, batchNo);
    if (!b) throw notFound(`BATCH_NOT_FOUND: ${batchNo}`);
    if (b.qty_on_hand < qty)
      throw badRequest(`BATCH_INSUFFICIENT_STOCK: ${batchNo} (have ${b.qty_on_hand}, need ${qty})`);
    // FEFO check: warn if an earlier batch expires sooner (caller should check warning)
    this.db.prepare('UPDATE product_batches SET qty_on_hand = qty_on_hand - ? WHERE id = ?').run(qty, b.id);
    return this.batches(productId);
  }

  fefoAllocate(productId, qty) {
    if (!Number.isInteger(qty) || qty <= 0) throw badRequest('QTY_MUST_BE_POSITIVE_INTEGER');
    const batches = this.db
      .prepare(
        'SELECT * FROM product_batches WHERE product_id = ? AND active = 1 AND qty_on_hand > 0 ORDER BY expiry_date ASC NULLS LAST, id',
      )
      .all(productId);
    let remaining = qty;
    const allocated = [];
    for (const b of batches) {
      if (remaining <= 0) break;
      const take = Math.min(b.qty_on_hand, remaining);
      this.db.prepare('UPDATE product_batches SET qty_on_hand = qty_on_hand - ? WHERE id = ?').run(take, b.id);
      allocated.push({ batch_no: b.batch_no, qty: take, expiry_date: b.expiry_date });
      remaining -= take;
    }
    if (remaining > 0) throw badRequest(`INSUFFICIENT_BATCH_STOCK: ${remaining} units unallocated`);
    return allocated;
  }

  // ---------- UOM ----------
  uomList(productId) {
    return this.db
      .prepare('SELECT * FROM product_uom WHERE product_id = ? ORDER BY is_base DESC, conversion_factor DESC')
      .all(productId);
  }

  setUom(productId, uomList) {
    this.db.prepare('DELETE FROM product_uom WHERE product_id = ?').run(productId);
    for (const u of uomList) {
      if (u.uomName) {
        this.db
          .prepare(
            'INSERT INTO product_uom (product_id, uom_name, conversion_factor, is_base, price_override_cents) VALUES (?, ?, ?, ?, ?)',
          )
          .run(
            productId,
            u.uomName,
            Number(u.conversionFactor ?? 1),
            u.isBase ? 1 : 0,
            u.priceOverrideCents != null ? Math.round(Number(u.priceOverrideCents)) : null,
          );
      }
    }
    return this.uomList(productId);
  }

  resolveUom(productId, uomName) {
    const u = this.db
      .prepare('SELECT * FROM product_uom WHERE product_id = ? AND uom_name = ?')
      .get(productId, uomName);
    if (!u) throw notFound(`UOM_NOT_FOUND: ${uomName}`);
    return u;
  }

  // ---------- bundles ----------
  bundleComponents(bundleId) {
    return this.db
      .prepare(
        `
      SELECT pb.*, p.sku, p.name, p.price_cents, p.cost_cents,
             COALESCE(s.qty_on_hand, 0) AS qty_on_hand, COALESCE(s.qty_reserved, 0) AS qty_reserved
      FROM product_bundles pb
      JOIN products p ON p.id = pb.component_product_id
      LEFT JOIN product_stock s ON s.product_id = pb.component_product_id
      WHERE pb.bundle_product_id = ?
    `,
      )
      .all(bundleId);
  }

  setBundle(bundleId, components) {
    this.db.prepare('DELETE FROM product_bundles WHERE bundle_product_id = ?').run(bundleId);
    for (const c of components) {
      if (c.componentProductId) {
        this.db
          .prepare(
            'INSERT INTO product_bundles (bundle_product_id, component_product_id, qty_required) VALUES (?, ?, ?)',
          )
          .run(bundleId, Number(c.componentProductId), Math.round(Number(c.qtyRequired ?? 1)));
      }
    }
    return this.bundleComponents(bundleId);
  }

  checkBundleAvailability(bundleId, qty) {
    const components = this.bundleComponents(bundleId);
    if (!components.length) throw badRequest('NOT_A_BUNDLE');
    const issues = [];
    for (const c of components) {
      const available = c.qty_on_hand - c.qty_reserved;
      const needed = c.qty_required * qty;
      if (available < needed) {
        issues.push({ component: c.name, needed, available });
      }
    }
    return { available: issues.length === 0, components, issues };
  }

  decomposeBundle(bundleId, qty) {
    const components = this.bundleComponents(bundleId);
    if (!components.length) throw badRequest('NOT_A_BUNDLE');
    return components.map((c) => ({
      productId: c.component_product_id,
      qty: c.qty_required * qty,
      name: c.name,
      sku: c.sku,
    }));
  }

  deleteProduct(id, tenantId) {
    this.getProduct(id, tenantId); // throws 404 if missing or out of scope
    this.db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(Number(id));
    return { ok: true };
  }

  // ---------- categories & tax ----------
  categories(tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    return this.db
      .prepare('SELECT * FROM product_categories WHERE tenant_id = ? AND active = 1 ORDER BY name')
      .all(tenant);
  }

  createCategory(name, tenantId) {
    if (!name) throw badRequest('CATEGORY_NAME_REQUIRED');
    const tenant = resolveTenantId(this.db, tenantId);
    try {
      return this.db.prepare('INSERT INTO product_categories (name, tenant_id) VALUES (?, ?)').run(name, tenant)
        .lastInsertRowid;
    } catch (e) {
      if (e.code === 'ERR_SQLITE_ERROR' && String(e.message).includes('UNIQUE'))
        throw conflict(`CATEGORY_EXISTS: ${name}`);
      throw e;
    }
  }

  taxClasses() {
    return this.db.prepare('SELECT * FROM tax_classes ORDER BY name').all();
  }
}

export { productRow };
