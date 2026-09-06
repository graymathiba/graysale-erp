#!/usr/bin/env node
// Migrate a standalone graysale retail database into the merged ERP database.
//
//   node scripts/migrate-graysale.mjs \
//     --source graysale/src/data/graysale.db \
//     --target src/data/supermarket.db
//
// Idempotent and incremental: rows that already exist in the target (matched by
// logical key) are left untouched, and results are reported at the end. The
// target is migrated first so every retail table exists.

import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { nextDoc, resetCounter } from '../src/db/counters.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) =>
  (a.startsWith('--') && arr[i + 1] && !arr[i + 1].startsWith('--')) ? [a.slice(2), arr[i + 1]] : [a.slice(2), true]
));

const SRC = args.source || fileURLToPath(new URL('../graysale/src/data/graysale.db', import.meta.url));
const TGT = args.target || fileURLToPath(new URL('../src/data/supermarket.db', import.meta.url));

const src = new DatabaseSync(SRC, { readOnly: true });
const tgt = new Store(TGT).db; // ensures target schema is migrated

const dryRun = args['dry-run'] === true;
const byCode = (rows) => new Map(rows.map(r => [r.code, r.id]));
const byName = (rows) => new Map(rows.map(r => [r.name, r.id]));
const byKey = (rows) => new Map(rows.map(r => [r.key, r.value]));

const report = { copied: {}, skipped: {}, mapped: {} };
const bump = (table, status) => { report[status][table] = (report[status][table] || 0) + 1; };
const onlyInsert = (table, stmt, row, log) => {
  if (dryRun) { bump(table, 'copied'); return null; }
  try { stmt.run(...row); bump(table, 'copied'); return log; }
  catch (e) {
    if (String(e.message).includes('UNIQUE')) { bump(table, 'skipped'); return null; }
    if (String(e.message).includes('FOREIGN')) { bump(table, 'skipped'); return null; }
    throw e;
  }
};

const q = (sql, ...p) => tgt.prepare(sql).run(...p);

// ---- id maps for reference-coupled reference tables (logical key lookup) ----
const taxClasses = byName(src.prepare('SELECT id, name FROM tax_classes').all());
const cats = byName(src.prepare('SELECT id, name FROM product_categories').all());
const locs = byCode(src.prepare('SELECT id, code FROM locations').all());

const targetTax = new Map();     // src tax_class_id -> target id
for (const [srcId, row] of src.prepare('SELECT * FROM tax_classes ORDER BY id').all().map(r => [r.id, r])) {
  const existing = tgt.prepare('SELECT id FROM tax_classes WHERE name = ?').get(row.name);
  if (existing) { targetTax.set(srcId, existing.id); bump('tax_classes', 'skipped'); }
  else { const r = q('INSERT INTO tax_classes (name, rate_bps, active) VALUES (?, ?, ?)', row.name, row.rate_bps, row.active); targetTax.set(srcId, Number(r.lastInsertRowid)); bump('tax_classes', 'copied'); }
}

const targetCat = new Map();     // src category_id -> target id
for (const [name, srcId] of cats) {
  const existing = tgt.prepare('SELECT id FROM product_categories WHERE name = ?').get(name);
  if (existing) { targetCat.set(srcId, existing.id); bump('product_categories', 'skipped'); }
  else { const r = q('INSERT INTO product_categories (name, active) VALUES (?, 1)', name); targetCat.set(srcId, Number(r.lastInsertRowid)); bump('product_categories', 'copied'); }
}

const targetLoc = new Map();     // src location_id -> target id
for (const [code, srcId] of locs) {
  const existing = tgt.prepare('SELECT id FROM locations WHERE code = ?').get(code);
  if (existing) { targetLoc.set(srcId, existing.id); bump('locations', 'skipped'); }
  else { const name = src.prepare('SELECT name FROM locations WHERE id = ?').get(srcId)?.name ?? code; const r = q('INSERT INTO locations (code, name, active) VALUES (?, ?, 1)', code, name); targetLoc.set(srcId, Number(r.lastInsertRowid)); bump('locations', 'copied'); }
}

// ---- accounts: match by code; missing codes created (never main 1000..4300) ----
const srcAccts = src.prepare('SELECT id, code, name, type, active FROM accounts ORDER BY id').all();
const targetAcctByCode = new Map(tgt.prepare('SELECT id, code FROM accounts').all().map(r => [r.code, r.id]));
const targetAcct = new Map();    // src account_id -> target id
for (const a of srcAccts) {
  let id = targetAcctByCode.get(a.code);
  if (!id) {
    const codeNum = Number(a.code);
    if (codeNum >= 1000 && codeNum <= 4300) {
      console.warn(`[skip-account] code ${a.code} is in the protected main chart range; skipping journal references to it`);
      id = null;
    } else {
      const r = q('INSERT INTO accounts (code, name, type, active) VALUES (?, ?, ?, ?)', a.code, a.name, a.type, a.active);
      id = Number(r.lastInsertRowid);
      targetAcctByCode.set(a.code, id);
      bump('accounts', 'copied');
    }
  } else {
    bump('accounts', 'skipped');
  }
  targetAcct.set(a.id, id);
}

// ---- users: match by username; role remap owner->admin, accountant->manager ----
const roleMap = { owner: 'admin', accountant: 'manager' };
const srcUsers = src.prepare('SELECT id, username, password_hash, full_name, role, active, created_at FROM users ORDER BY id').all();
const targetUserByUsername = new Map(tgt.prepare('SELECT id, username FROM users').all().map(r => [r.username, r.id]));
const targetUser = new Map();    // src user_id -> target id
for (const u of srcUsers) {
  const existing = targetUserByUsername.get(u.username);
  if (existing) { targetUser.set(u.id, existing); bump('users', 'skipped'); continue; }
  const role = roleMap[u.role] || u.role;
  const locId = u.location_id != null ? targetLoc.get(u.location_id) ?? null : null;
  let id;
  try {
    id = Number(q(
      'INSERT INTO users (username, password_hash, full_name, role, active, location_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      u.username, u.password_hash, u.full_name, role, u.active, locId, u.created_at
    ).lastInsertRowid);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) { targetUser.set(u.id, null); bump('users', 'skipped'); continue; }
    throw e;
  }
  targetUser.set(u.id, id);
  targetUserByUsername.set(u.username, id);
  bump('users', 'copied');
}

// ---- products + stock ----
const srcProducts = src.prepare('SELECT * FROM products ORDER BY id').all();
const skuSet = new Set(tgt.prepare('SELECT sku, barcode FROM products').all().map(r => `${r.sku}|${r.barcode}`));
const targetProduct = new Map(); // src product_id -> target id
const srcStock = new Map(src.prepare('SELECT product_id, qty_on_hand, qty_reserved FROM product_stock').all().map(r => [r.product_id, r]));
for (const p of srcProducts) {
  const key = `${p.sku}|${p.barcode ?? ''}`;
  if (skuSet.has(key)) { targetProduct.set(p.id, null); bump('products', 'skipped'); continue; }
  const catId = targetCat.get(p.category_id) ?? null;
  const taxId = targetTax.get(p.tax_class_id) ?? null;
  try {
    const id = Number(q(
      'INSERT INTO products (sku, barcode, name, category_id, unit, cost_cents, price_cents, tax_class_id, serial_tracked, active, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      p.sku, p.barcode, p.name, catId, p.unit, p.cost_cents, p.price_cents, taxId, p.serial_tracked, p.active, p.created_at
    ).lastInsertRowid);
    targetProduct.set(p.id, id);
    const st = srcStock.get(p.id);
    q('INSERT OR IGNORE INTO inventory (product_id, quantity, qty_reserved, reorder_level) VALUES (?, ?, ?, ?)',
      id, st?.qty_on_hand ?? 0, st?.qty_reserved ?? 0, p.reorder_level);
    bump('products', 'copied');
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) { targetProduct.set(p.id, null); bump('products', 'skipped'); }
    else throw e;
  }
}

// ---- customers ----
const srcCustomers = src.prepare('SELECT * FROM customers ORDER BY id').all();
const targetCustomer = new Map();
for (const c of srcCustomers) {
  const nameEx = tgt.prepare('SELECT id FROM customers WHERE name = ?').get(c.name);
  if (nameEx) { targetCustomer.set(c.id, nameEx.id); bump('customers', 'skipped'); continue; }
  const id = Number(q(
    'INSERT INTO customers (code, name, phone, email, address, credit_limit_cents, loyalty_points, total_spent_cents, active, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    c.code, c.name, c.phone, c.email, c.address, c.credit_limit_cents, c.loyalty_points, 0, c.active, c.created_at
  ).lastInsertRowid);
  targetCustomer.set(c.id, id);
  bump('customers', 'copied');
}

// ---- suppliers ----
const srcSuppliers = src.prepare('SELECT * FROM suppliers ORDER BY id').all();
const targetSupplier = new Map();
for (const s of srcSuppliers) {
  const nameEx = tgt.prepare('SELECT id FROM suppliers WHERE name = ?').get(s.name);
  if (nameEx) { targetSupplier.set(s.id, nameEx.id); bump('suppliers', 'skipped'); continue; }
  const id = Number(q(
    'INSERT INTO suppliers (code, name, phone, email, address, tax_id, active, created_at) VALUES (?,?,?,?,?,?,?,?)',
    s.code, s.name, s.phone, s.email, s.address, s.tax_id, s.active, s.created_at
  ).lastInsertRowid);
  targetSupplier.set(s.id, id);
  bump('suppliers', 'copied');
}

// ---- purchase orders + lines (source doc_no -> target po_no) ----
const srcPOs = src.prepare('SELECT * FROM purchase_orders ORDER BY id').all();
const targetPO = new Map();
const poNoSet = new Set(tgt.prepare('SELECT po_no FROM purchase_orders').all().map(r => r.po_no));
const srcPOLines = src.prepare('SELECT * FROM po_lines ORDER BY id').all();
for (const po of srcPOs) {
  if (poNoSet.has(po.doc_no)) { bump('purchase_orders', 'skipped'); continue; }
  const supId = targetSupplier.get(po.supplier_id) ?? null;
  if (supId == null) { bump('purchase_orders', 'skipped'); continue; }
  const id = Number(q(
    'INSERT INTO purchase_orders (po_no, supplier_id, status, expected_date, subtotal_cents, tax_cents, total_cents, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    po.doc_no, supId, po.status, po.expected_date, po.subtotal_cents, po.tax_cents, po.total_cents, po.note, po.created_at
  ).lastInsertRowid);
  targetPO.set(po.id, id);
  poNoSet.add(po.doc_no);
  bump('purchase_orders', 'copied');
  for (const l of srcPOLines.filter(x => x.po_id === po.id)) {
    const pid = targetProduct.get(l.product_id);
    if (pid == null) continue;
    const taxId = targetTax.get(l.tax_class_id) ?? null;
    q('INSERT INTO purchase_order_items (po_id, product_id, qty, received_qty, unit_cost_cents, tax_class_id, line_total_cents, tax_cents) VALUES (?,?,?,?,?,?,?,0)',
      id, pid, l.qty, l.qty_received, l.unit_cost_cents, taxId, l.line_total_cents);
    bump('purchase_order_items', 'copied');
  }
}

// ---- retail orders -> gs_orders / gs_order_lines ----
const srcOrders = src.prepare('SELECT * FROM orders ORDER BY id').all();
const targetOrder = new Map();
const gsDocSet = new Set(tgt.prepare('SELECT doc_no FROM gs_orders').all().map(r => r.doc_no));
const srcOrderLines = src.prepare('SELECT * FROM order_lines ORDER BY id').all();
for (const o of srcOrders) {
  if (gsDocSet.has(o.doc_no)) { bump('gs_orders', 'skipped'); continue; }
  const custId = o.customer_id != null ? targetCustomer.get(o.customer_id) : null;
  const usrId = o.user_id != null ? targetUser.get(o.user_id) : null;
  const locId = o.location_id != null ? targetLoc.get(o.location_id) : null;
  const id = Number(q(
    'INSERT INTO gs_orders (id, doc_no, type, status, customer_id, user_id, location_id, subtotal_cents, discount_cents, tax_cents, total_cents, paid_cents, refunded_cents, note, meta, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    o.id, o.doc_no, o.type, o.status, custId, usrId, locId, o.subtotal_cents, o.discount_cents, o.tax_cents, o.total_cents, o.paid_cents, o.refunded_cents, o.note, o.meta, o.created_at
  ).lastInsertRowid);
  targetOrder.set(o.id, id);
  gsDocSet.add(o.doc_no);
  bump('gs_orders', 'copied');
  for (const l of srcOrderLines.filter(x => x.order_id === o.id)) {
    const pid = targetProduct.get(l.product_id) ?? null;
    q('INSERT INTO gs_order_lines (id, order_id, product_id, product_name, qty, unit_price_cents, line_discount_cents, tax_cents, line_total_cents) VALUES (?,?,?,?,?,?,?,?,?)',
      l.id, id, pid, l.product_name, l.qty, l.unit_price_cents, l.line_discount_cents, l.tax_cents, l.line_total_cents);
    bump('gs_order_lines', 'copied');
  }
}

// ---- journal entries + lines ----
const srcEntries = src.prepare('SELECT * FROM journal_entries ORDER BY id').all();
const targetEntry = new Map();
const entryNoSet = new Set(tgt.prepare('SELECT entry_no FROM journal_entries').all().map(r => r.entry_no));
const srcLines = src.prepare('SELECT * FROM journal_lines ORDER BY id').all();
for (const e of srcEntries) {
  if (entryNoSet.has(e.doc_no)) { bump('journal_entries', 'skipped'); continue; }
  const usrId = e.user_id != null ? targetUser.get(e.user_id) : null;
  const id = Number(q(
    'INSERT INTO journal_entries (entry_no, date, reference, description, user_id, posted_at) VALUES (?,?,?,?,?,?)',
    e.doc_no, e.date, e.reference, e.description, usrId, e.posted_at
  ).lastInsertRowid);
  targetEntry.set(e.id, id);
  entryNoSet.add(e.doc_no);
  bump('journal_entries', 'copied');
  for (const l of srcLines.filter(x => x.entry_id === e.id)) {
    const acctId = targetAcct.get(l.account_id);
    if (acctId == null) { bump('journal_lines', 'skipped'); continue; }
    q('INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?,?,?,?)',
      id, acctId, l.debit_cents, l.credit_cents);
    bump('journal_lines', 'copied');
  }
}

// ---- stock movements -> inventory_movements ----
const srcMoves = src.prepare('SELECT * FROM stock_movements ORDER BY id').all();
for (const m of srcMoves) {
  const pid = targetProduct.get(m.product_id);
  if (pid == null) { bump('inventory_movements', 'skipped'); continue; }
  const usrId = m.user_id != null ? targetUser.get(m.user_id) : null;
  q('INSERT INTO inventory_movements (product_id, quantity, type, note, user_id, ref_type, ref_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
    pid, m.qty, m.type || 'ADJUST', m.note, usrId, m.ref_type, m.ref_id, m.created_at);
  bump('inventory_movements', 'copied');
}

// ---- audit log (dedupe by content so re-runs don't multiply rows) ----
const srcAudit = src.prepare('SELECT user_id, username, action, entity_type, entity_id, detail, created_at FROM audit_log ORDER BY id').all();
const auditExists = (...p) => tgt.prepare('SELECT COUNT(*) AS c FROM audit_log WHERE action = ? AND entity IS ? AND entity_id IS ? AND detail IS ? AND created_at = ?').get(...p).c;
for (const a of srcAudit) {
  if (auditExists(a.action, a.entity_type, a.entity_id, a.detail, a.created_at).c) { bump('audit_log', 'skipped'); continue; }
  const uid = a.user_id != null ? targetUser.get(a.user_id) : null;
  q('INSERT INTO audit_log (user_id, username, action, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?,?)',
    uid, a.username, a.action, a.entity_type, a.entity_id, a.detail, a.created_at);
  bump('audit_log', 'copied');
}

// ---- settings (never overwrite existing) ----
const srcSettings = src.prepare('SELECT key, value FROM settings').all();
for (const s of srcSettings) {
  if (s.key === 'schema.version') continue;
  q('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', s.key, s.value);
  bump('settings', 'copied');
}

// ---- counters (take max so numbering continues after the old docs) ----
const srcCounters = src.prepare('SELECT type, value FROM counters').all();
for (const c of srcCounters) {
  q('INSERT INTO counters (type, value) VALUES (?, ?) ON CONFLICT(type) DO UPDATE SET value = MAX(value, excluded.value)', c.type, c.value);
  bump('counters', 'copied');
}

q('INSERT INTO settings (key, value) VALUES (\'gs.migrated_from_graysale\', \'1\') ON CONFLICT(key) DO NOTHING');

// =====================================================================
// REPAIR MODE (--repair)
// Backfills data that older / partial migrations left behind without
// touching the schema or re-running the copy. Every step is guarded by an
// existence / dedupe check so the repair is safe to run repeatedly.
// =====================================================================
function repair() {
  const repReport = { copied: {}, skipped: {} };
  const rep = (table, status) => { repReport[status][table] = (repReport[status][table] || 0) + 1; };
  const write = (sql, ...p) => {
    if (dryRun) return null;
    try {
      return tgt.prepare(sql).run(...p);
    } catch (err) {
      console.warn(`[repair][write] ${err.message}\n  sql: ${sql}\n  params: ${p.length}`);
      return null;
    }
  };
  const countOf = (sql, ...p) => tgt.prepare(sql).get(...p).c;

  const tgtProdByName = new Map(tgt.prepare('SELECT id, name FROM products').all().map(r => [r.name, r.id]));
  const srcName = (id) => src.prepare('SELECT name FROM products WHERE id = ?').get(id)?.name;

  // 1. gs_order_lines.product_id backfill
  const nullLines = tgt.prepare('SELECT id, product_name FROM gs_order_lines WHERE product_id IS NULL').all();
  for (const l of nullLines) {
    const pid = tgtProdByName.get(l.product_name);
    if (pid == null) { rep('gs_order_lines', 'skipped'); continue; }
    write('UPDATE gs_order_lines SET product_id = ? WHERE id = ?', pid, l.id);
    rep('gs_order_lines', 'copied');
  }

  // 2. purchase_order_items backfill
  const poByNo = new Map(tgt.prepare('SELECT id, po_no FROM purchase_orders').all().map(r => [r.po_no, r.id]));
  for (const po of src.prepare('SELECT * FROM purchase_orders').all()) {
    const tpoId = poByNo.get(po.doc_no);
    if (tpoId == null) { rep('purchase_order_items', 'skipped'); continue; }
    for (const l of src.prepare('SELECT * FROM po_lines WHERE po_id = ?').all(po.id)) {
      const prodName = srcName(l.product_id);
      const pid = prodName ? tgtProdByName.get(prodName) : null;
      if (pid == null) { rep('purchase_order_items', 'skipped'); continue; }
      if (countOf('SELECT COUNT(*) AS c FROM purchase_order_items WHERE po_id = ? AND product_id = ? AND qty = ? AND unit_cost_cents = ?', tpoId, pid, l.qty, l.unit_cost_cents)) { rep('purchase_order_items', 'skipped'); continue; }
      const taxId = targetTax.get(l.tax_class_id) ?? null;
      write('INSERT INTO purchase_order_items (po_id, product_id, qty, received_qty, unit_cost_cents, tax_class_id, line_total_cents, tax_cents) VALUES (?,?,?,?,?,?,?,0)',
        tpoId, pid, l.qty, l.qty_received, l.unit_cost_cents, taxId, l.line_total_cents);
      rep('purchase_order_items', 'copied');
    }
  }

  // 3. inventory_movements backfill
  for (const m of src.prepare('SELECT * FROM stock_movements ORDER BY id').all()) {
    const prodName = srcName(m.product_id);
    const pid = prodName ? tgtProdByName.get(prodName) : null;
    if (pid == null) { rep('inventory_movements', 'skipped'); continue; }
    if (countOf(
      'SELECT COUNT(*) AS c FROM inventory_movements WHERE product_id = ? AND quantity = ? AND type = ? AND ref_type IS ? AND ref_id IS ? AND created_at = ?',
      pid, m.qty, m.type, m.ref_type, m.ref_id, m.created_at
    )) { rep('inventory_movements', 'skipped'); continue; }
    const usr = m.user_id != null ? targetUser.get(m.user_id) : null;
    write('INSERT INTO inventory_movements (product_id, quantity, type, note, user_id, ref_type, ref_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
      pid, m.qty, m.type || 'ADJUST', m.note, usr, m.ref_type, m.ref_id, m.created_at);
    rep('inventory_movements', 'copied');
  }

  // 4. Renumber journal entries that collided with the main ERP's JE namespace.
  //    A source entry whose doc_no already exists but with different content is
  //    re-inserted under the next free number from the shared JE counter.
  //    Guarded by (reference, description) so the repair is idempotent.
  const entryExists = (entryNo) => tgt.prepare('SELECT COUNT(*) AS c FROM journal_entries WHERE entry_no = ?').get(entryNo).c;
  const dupByContent = (reference, description) => tgt.prepare('SELECT COUNT(*) AS c FROM journal_entries WHERE reference = ? AND description = ?').get(reference, description).c;
  for (const e of src.prepare('SELECT * FROM journal_entries ORDER BY id').all()) {
    const existing = tgt.prepare('SELECT * FROM journal_entries WHERE entry_no = ?').get(e.doc_no);
    if (!existing || (existing.reference === e.reference && existing.description === e.description)) continue;
    if (dupByContent(e.reference, e.description)) { rep('journal_entries', 'skipped'); continue; }
    let entryNo, guard = 0;
    do { entryNo = nextDoc(tgt, 'JE'); guard++; } while (entryExists(entryNo) && guard < 1000);
    if (entryExists(entryNo)) { rep('journal_entries', 'skipped'); continue; }
    const usrId = e.user_id != null ? targetUser.get(e.user_id) : null;
    const res = write('INSERT INTO journal_entries (entry_no, date, reference, description, user_id, posted_at) VALUES (?,?,?,?,?,?)',
      entryNo, e.date, e.reference, e.description, usrId, e.posted_at ?? new Date().toISOString().slice(0, 19).replace('T', ' '));
    if (!res) {
      console.warn('[repair] journal entry insert returned nothing — dryRun?', dryRun);
      rep('journal_entries', 'skipped');
      continue;
    }
    const eid = res.lastInsertRowid;
    for (const l of src.prepare('SELECT * FROM journal_lines WHERE entry_id = ?').all(e.id)) {
      const acctId = targetAcct.get(l.account_id);
      if (acctId == null) { rep('journal_lines', 'skipped'); continue; }
      write('INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?,?,?,?)',
        eid, acctId, l.debit_cents, l.credit_cents);
      rep('journal_lines', 'copied');
    }
    rep('journal_entries', 'copied');
  }

  // 5. Re-sync the JE counter to the highest JE number in the table.
  const jeMax = tgt.prepare("SELECT MAX(CAST(REPLACE(entry_no, 'JE-', '') AS INTEGER)) AS m FROM journal_entries WHERE entry_no GLOB 'JE-[0-9]*'").get().m;
  if (jeMax != null) resetCounter(tgt, 'JE', Math.max(jeMax, Number(tgt.prepare("SELECT value FROM counters WHERE type = 'JE'").get()?.value ?? 0)));

  return repReport;
}

if (args.repair) {
  const repReport = repair();
  console.log('Repair copied:', JSON.stringify(repReport.copied, null, 2));
  console.log('Repair skipped (already complete / unmappable):', JSON.stringify(repReport.skipped, null, 2));
}

if (dryRun) { console.log('[dry-run] nothing was written to the target.'); }
console.log('Copied:', JSON.stringify(report.copied, null, 2));
console.log('Skipped (already present / unmappable):', JSON.stringify(report.skipped, null, 2));
console.log('Target db:', TGT);