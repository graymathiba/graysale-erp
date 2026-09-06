import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.DB_PATH || fileURLToPath(new URL('../data/supermarket.db', import.meta.url));

export function createDb(path = DB_PATH) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

const SCHEMA_VERSION = 4;

export function migrate(db) {
  const version = getVersion(db);
  if (version < 1) migrateV1(db);
  if (version < 2) migrateV2(db);
  if (version < 3) migrateV3(db);
  if (version < 4) migrateV4(db);
  setVersion(db, SCHEMA_VERSION);
}

function getVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get();
    return row ? Number(row.value) : 0;
  } catch { return 0; }
}

function setVersion(db, v) {
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)").run(String(v));
}

function migrateV1(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE NOT NULL,
    barcode TEXT UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'General',
    price_cents INTEGER NOT NULL DEFAULT 0,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    tax_rate REAL NOT NULL DEFAULT 0.00,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity REAL NOT NULL DEFAULT 0,
    reorder_level REAL NOT NULL DEFAULT 0,
    location TEXT NOT NULL DEFAULT 'MAIN',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS inventory_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity REAL NOT NULL,
    type TEXT NOT NULL,
    note TEXT,
    location TEXT NOT NULL DEFAULT 'MAIN',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    loyalty_points INTEGER NOT NULL DEFAULT 0,
    total_spent_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_no TEXT UNIQUE NOT NULL,
    customer_id INTEGER REFERENCES customers(id),
    subtotal_cents INTEGER NOT NULL DEFAULT 0,
    discount_cents INTEGER NOT NULL DEFAULT 0,
    tax_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT 'cash',
    cash_received_cents INTEGER,
    card_amount_cents INTEGER NOT NULL DEFAULT 0,
    card_reference TEXT,
    change_cents INTEGER NOT NULL DEFAULT 0,
    loyalty_points_earned INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'complete',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    product_name TEXT NOT NULL,
    qty REAL NOT NULL,
    unit_price_cents INTEGER NOT NULL,
    line_total_cents INTEGER NOT NULL,
    tax_cents INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS returns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL REFERENCES sales(id),
    return_no TEXT UNIQUE NOT NULL,
    subtotal_cents INTEGER NOT NULL DEFAULT 0,
    tax_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'complete',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS return_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_id INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
    sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty REAL NOT NULL,
    unit_price_cents INTEGER NOT NULL,
    line_total_cents INTEGER NOT NULL,
    tax_cents INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    balance_cents INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_no TEXT UNIQUE NOT NULL,
    reference TEXT,
    description TEXT,
    posted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS journal_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    debits_cents INTEGER NOT NULL DEFAULT 0,
    credits_cents INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    department TEXT,
    hourly_rate_cents INTEGER NOT NULL DEFAULT 0,
    email TEXT,
    phone TEXT,
    hire_date TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS benefits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    plan_name TEXT NOT NULL,
    provider TEXT,
    monthly_cost_cents INTEGER NOT NULL DEFAULT 0,
    employer_contribution_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    enrolled_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payroll (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER REFERENCES employees(id),
    employee_name TEXT NOT NULL,
    role TEXT NOT NULL,
    hourly_rate_cents INTEGER NOT NULL DEFAULT 0,
    hours REAL NOT NULL DEFAULT 0,
    gross_cents INTEGER NOT NULL DEFAULT 0,
    tax_cents INTEGER NOT NULL DEFAULT 0,
    net_cents INTEGER NOT NULL DEFAULT 0,
    period TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_no TEXT UNIQUE NOT NULL,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    total_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS purchase_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty REAL NOT NULL,
    received_qty REAL NOT NULL DEFAULT 0,
    unit_cost_cents INTEGER NOT NULL,
    line_total_cents INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_no TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    party_id INTEGER,
    party_name TEXT,
    sale_id INTEGER REFERENCES sales(id),
    po_id INTEGER REFERENCES purchase_orders(id),
    subtotal_cents INTEGER NOT NULL DEFAULT 0,
    tax_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL DEFAULT 0,
    paid_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    due_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at TEXT
  );

  CREATE TABLE IF NOT EXISTS invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id),
    description TEXT,
    qty REAL NOT NULL DEFAULT 1,
    unit_price_cents INTEGER NOT NULL,
    line_total_cents INTEGER NOT NULL,
    tax_cents INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_no TEXT UNIQUE NOT NULL,
    customer_id INTEGER REFERENCES customers(id),
    customer_name TEXT,
    subtotal_cents INTEGER NOT NULL DEFAULT 0,
    tax_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    valid_until TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    converted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS quote_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id),
    product_name TEXT,
    qty REAL NOT NULL,
    unit_price_cents INTEGER NOT NULL,
    line_total_cents INTEGER NOT NULL,
    tax_cents INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS shipments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracking_no TEXT UNIQUE NOT NULL,
    po_id INTEGER REFERENCES purchase_orders(id),
    supplier_id INTEGER REFERENCES suppliers(id),
    carrier TEXT,
    status TEXT NOT NULL DEFAULT 'preparing',
    estimated_arrival TEXT,
    actual_arrival TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS approval_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    risk_score REAL,
    requested_by TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS saga_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    saga_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    status TEXT NOT NULL,
    domain TEXT,
    payload TEXT,
    result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS message_dedup (
    message_id TEXT PRIMARY KEY,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sales_by_day (
    sale_date TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    revenue_cents INTEGER NOT NULL DEFAULT 0,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    profit_cents INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'cashier',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    username TEXT,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id INTEGER,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT,
    path TEXT,
    status INTEGER,
    duration_ms INTEGER,
    user_id INTEGER,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sales_receipt_no ON sales(receipt_no);
  CREATE INDEX IF NOT EXISTS idx_sales_customer_id ON sales(customer_id);
  CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);
  CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at);
  CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);
  CREATE INDEX IF NOT EXISTS idx_sale_items_product_id ON sale_items(product_id);
  CREATE INDEX IF NOT EXISTS idx_inventory_movements_product_id ON inventory_movements(product_id);
  CREATE INDEX IF NOT EXISTS idx_inventory_movements_created_at ON inventory_movements(created_at);
  CREATE INDEX IF NOT EXISTS idx_journal_entries_reference ON journal_entries(reference);
  CREATE INDEX IF NOT EXISTS idx_journal_entries_posted_at ON journal_entries(posted_at);
  CREATE INDEX IF NOT EXISTS idx_journal_lines_entry_id ON journal_lines(entry_id);
  CREATE INDEX IF NOT EXISTS idx_journal_lines_account_id ON journal_lines(account_id);
  CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
  CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_payroll_period ON payroll(period);
  CREATE INDEX IF NOT EXISTS idx_payroll_employee_name ON payroll(employee_name);
  CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier_id ON purchase_orders(supplier_id);
  CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);
  CREATE INDEX IF NOT EXISTS idx_purchase_order_items_po_id ON purchase_order_items(po_id);
  CREATE INDEX IF NOT EXISTS idx_invoices_type ON invoices(type);
  CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
  CREATE INDEX IF NOT EXISTS idx_invoices_party_id ON invoices(party_id);
  CREATE INDEX IF NOT EXISTS idx_quotes_customer_id ON quotes(customer_id);
  CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
  CREATE INDEX IF NOT EXISTS idx_shipments_tracking_no ON shipments(tracking_no);
  CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
  CREATE INDEX IF NOT EXISTS idx_returns_sale_id ON returns(sale_id);
  CREATE INDEX IF NOT EXISTS idx_approval_queue_status ON approval_queue(status);
  CREATE INDEX IF NOT EXISTS idx_saga_log_saga_id ON saga_log(saga_id);
  CREATE INDEX IF NOT EXISTS idx_request_log_created_at ON request_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_request_log_path ON request_log(path);
  `);
}

function migrateV2(db) {
  // Add location column to inventory if missing (for multi-location)
  try { db.exec("ALTER TABLE inventory ADD COLUMN location TEXT NOT NULL DEFAULT 'MAIN'"); } catch (_) {}
  try { db.exec("ALTER TABLE inventory_movements ADD COLUMN location TEXT NOT NULL DEFAULT 'MAIN'"); } catch (_) {}
  try { db.exec("ALTER TABLE sales ADD COLUMN card_amount_cents INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
  try { db.exec("ALTER TABLE sales ADD COLUMN card_reference TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE purchase_orders ADD COLUMN notes TEXT"); } catch (_) {}
  try { db.exec("ALTER TABLE purchase_order_items ADD COLUMN received_qty REAL NOT NULL DEFAULT 0"); } catch (_) {}
  // Add result column to message_dedup for caching orchestrator results
  try { db.exec("ALTER TABLE message_dedup ADD COLUMN result TEXT"); } catch (_) {}
}

function migrateV3(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS user_capabilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    capability TEXT NOT NULL,
    granted_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, capability)
  );

  CREATE INDEX IF NOT EXISTS idx_user_capabilities_user_id ON user_capabilities(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_capabilities_capability ON user_capabilities(capability);
  `);
}

// ── v4: Unified database — brings the GraySale retail suite onto the main ERP
// schema so one file, one login, one ledger serve both applications. ──────────
// Adds the retail feature tables (built with CREATE IF NOT EXISTS so a previous
// run is harmless) plus the columns main tables need to carry retail data.
const GS_EXTRA_ACCOUNTS = [
  ['1010', 'Bank – Main', 'asset'],
  ['1490', 'Input Tax (Purchases)', 'asset'],
  ['2010', 'Accounts Payable (Retail)', 'liability'],
  ['2060', 'Output Tax (Adjustments)', 'liability'],
  ['2100', 'Output Tax (Sales)', 'liability'],
  ['2200', 'Customer Deposits (Layaway)', 'liability'],
  ['3200', 'Retained Earnings', 'equity'],
  ['4110', 'Sales Discounts', 'revenue'],
  ['4120', 'Sales Returns', 'revenue'],
  ['4600', 'Other Income', 'revenue'],
  ['5100', 'Cost of Goods Sold (POS)', 'expense'],
  ['6100', 'Salaries & Wages', 'expense'],
  ['6200', 'Rent', 'expense'],
  ['6300', 'Utilities', 'expense'],
  ['6400', 'Operating Expenses (Retail)', 'expense'],
  ['6500', 'Bank Charges', 'expense'],
];

const GS_BASE_SETTINGS = [
  ['company.name', 'My Store'],
  ['company.address', ''],
  ['company.phone', ''],
  ['company.tin', ''],
  ['company.currency', '$'],
  ['tax.name', 'VAT'],
  ['doc.default_terms_days', '14'],
  ['pos.fiscal', '0'],
  ['pos.cash_drawer', '0'],
];

// Base chart of accounts the main POS and retail suite rely on. Seeded inline so
// a fresh database is usable without running scripts/seed (the old standalone
// base chart was only created by seed.js/existing DBs).
const GS_BASE_ACCOUNTS = [
  ['1000', 'Cash', 'asset'],
  ['1100', 'Accounts Receivable', 'asset'],
  ['1200', 'Inventory', 'asset'],
  ['2000', 'Accounts Payable', 'liability'],
  ['3000', 'Owner Equity', 'equity'],
  ['3100', 'Retained Earnings', 'equity'],
  ['4000', 'Sales Revenue', 'revenue'],
  ['4100', 'Cost of Goods Sold', 'expense'],
  ['4200', 'Tax Payable (Sales)', 'liability'],
  ['4300', 'Operating Expenses', 'expense'],
];

function migrateV4(db) {
  // --- retail feature tables (never collide with main tables) ---
  // Created first so the ALTER statements below can reference tax_classes.
  db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS tax_classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    rate_bps INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS product_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS gs_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    customer_id INTEGER REFERENCES customers(id),
    user_id INTEGER REFERENCES users(id),
    location_id INTEGER,
    subtotal_cents INTEGER NOT NULL DEFAULT 0,
    discount_cents INTEGER NOT NULL DEFAULT 0,
    tax_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL DEFAULT 0,
    paid_cents INTEGER NOT NULL DEFAULT 0,
    refunded_cents INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    meta TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS gs_order_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES gs_orders(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id),
    product_name TEXT NOT NULL,
    qty INTEGER NOT NULL,
    unit_price_cents INTEGER NOT NULL,
    line_discount_cents INTEGER NOT NULL DEFAULT 0,
    tax_cents INTEGER NOT NULL DEFAULT 0,
    line_total_cents INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ar_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no TEXT UNIQUE NOT NULL,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    order_id INTEGER REFERENCES gs_orders(id),
    kind TEXT NOT NULL DEFAULT 'INVOICE',
    date TEXT NOT NULL,
    due_date TEXT,
    subtotal_cents INTEGER NOT NULL DEFAULT 0,
    discount_cents INTEGER NOT NULL DEFAULT 0,
    tax_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL DEFAULT 0,
    paid_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'OPEN',
    voided INTEGER NOT NULL DEFAULT 0,
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS ap_bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no TEXT UNIQUE NOT NULL,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    po_id INTEGER REFERENCES purchase_orders(id),
    date TEXT NOT NULL,
    due_date TEXT,
    subtotal_cents INTEGER NOT NULL DEFAULT 0,
    tax_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL DEFAULT 0,
    paid_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'OPEN',
    voided INTEGER NOT NULL DEFAULT 0,
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS goods_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no TEXT UNIQUE NOT NULL,
    po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
    supplier_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id),
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL,
    party_type TEXT NOT NULL,
    party_id INTEGER NOT NULL,
    method TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    reference TEXT,
    date TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id),
    voided INTEGER NOT NULL DEFAULT 0,
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS payment_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    invoice_type TEXT NOT NULL,
    invoice_id INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bank_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL,
    opening_cents INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS bank_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
    date TEXT NOT NULL,
    memo TEXT,
    amount_cents INTEGER NOT NULL,
    payment_id INTEGER REFERENCES payments(id),
    reconciled INTEGER NOT NULL DEFAULT 0,
    rec_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS reconciliations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
    statement_date TEXT NOT NULL,
    closing_balance_cents INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS counters (
    type TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no TEXT UNIQUE NOT NULL,
    user_id INTEGER REFERENCES users(id),
    location_id INTEGER,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    opening_cash_cents INTEGER NOT NULL DEFAULT 0,
    counted_cash_cents INTEGER,
    expected_cash_cents INTEGER,
    variance_cents INTEGER,
    status TEXT NOT NULL DEFAULT 'OPEN'
  );

  CREATE TABLE IF NOT EXISTS printers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT '80mm',
    connection TEXT NOT NULL DEFAULT 'USB',
    ip_address TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    cash_drawer INTEGER NOT NULL DEFAULT 0,
    fiscal INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_gs_orders_type ON gs_orders(type);
  CREATE INDEX IF NOT EXISTS idx_gs_orders_status ON gs_orders(status);
  CREATE INDEX IF NOT EXISTS idx_gs_orders_customer_id ON gs_orders(customer_id);
  CREATE INDEX IF NOT EXISTS idx_gs_orders_created_at ON gs_orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_gs_order_lines_order_id ON gs_order_lines(order_id);
  CREATE INDEX IF NOT EXISTS idx_ar_invoices_customer_id ON ar_invoices(customer_id);
  CREATE INDEX IF NOT EXISTS idx_ap_bills_supplier_id ON ap_bills(supplier_id);
  CREATE INDEX IF NOT EXISTS idx_payments_party ON payments(party_type, party_id);
  CREATE INDEX IF NOT EXISTS idx_bank_transactions_bank_account_id ON bank_transactions(bank_account_id);
  CREATE INDEX IF NOT EXISTS idx_shifts_user_id ON shifts(user_id);
  `);

  // --- main-table column extensions (after retail tables exist) ---
  try { db.exec("ALTER TABLE products ADD COLUMN unit TEXT NOT NULL DEFAULT 'each'"); } catch (_) {}
  try { db.exec('ALTER TABLE products ADD COLUMN tax_class_id INTEGER REFERENCES tax_classes(id)'); } catch (_) {}
  try { db.exec('ALTER TABLE products ADD COLUMN serial_tracked INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE products ADD COLUMN category_id INTEGER'); } catch (_) {}
  try { db.exec('ALTER TABLE inventory ADD COLUMN qty_reserved REAL NOT NULL DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE customers ADD COLUMN code TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE customers ADD COLUMN address TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE customers ADD COLUMN credit_limit_cents INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE customers ADD COLUMN active INTEGER NOT NULL DEFAULT 1'); } catch (_) {}
  try { db.exec('ALTER TABLE suppliers ADD COLUMN code TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE suppliers ADD COLUMN address TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE suppliers ADD COLUMN tax_id TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE suppliers ADD COLUMN active INTEGER NOT NULL DEFAULT 1'); } catch (_) {}
  try { db.exec('ALTER TABLE purchase_orders ADD COLUMN expected_date TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE purchase_orders ADD COLUMN subtotal_cents INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE purchase_orders ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE purchase_order_items ADD COLUMN tax_class_id INTEGER'); } catch (_) {}
  try { db.exec('ALTER TABLE purchase_order_items ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE journal_entries ADD COLUMN date TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE journal_entries ADD COLUMN user_id INTEGER REFERENCES users(id)'); } catch (_) {}
  try { db.exec('ALTER TABLE inventory_movements ADD COLUMN user_id INTEGER'); } catch (_) {}
  try { db.exec('ALTER TABLE inventory_movements ADD COLUMN ref_type TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE inventory_movements ADD COLUMN ref_id INTEGER'); } catch (_) {}
  try { db.exec('ALTER TABLE users ADD COLUMN location_id INTEGER'); } catch (_) {}
  // The main returns journal references account 2060 which never existed;
  // the v4 chart guarantees it (guarded seed below).
  const baseSeeded = db.prepare("SELECT value FROM settings WHERE key = 'gs.base'").get();
  if (!baseSeeded) {
    try {
      db.exec('BEGIN');
      for (const [key, value] of GS_BASE_SETTINGS) {
        db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
      }
      for (const [code, name, type] of [...GS_BASE_ACCOUNTS, ...GS_EXTRA_ACCOUNTS]) {
        db.prepare('INSERT OR IGNORE INTO accounts (code, name, type) VALUES (?, ?, ?)').run(code, name, type);
      }
      const insTax = db.prepare('INSERT INTO tax_classes (name, rate_bps) VALUES (?, ?)');
      const hasTax = db.prepare('SELECT COUNT(*) AS c FROM tax_classes').get().c;
      if (hasTax === 0) {
        for (const [name, rate] of [['Zero Rated', 0], ['Standard', 1500], ['Reduced', 750]]) {
          insTax.run(name, rate);
        }
      }
      const hasCat = db.prepare('SELECT COUNT(*) AS c FROM product_categories').get().c;
      if (hasCat === 0) db.prepare('INSERT INTO product_categories (name) VALUES (?)').run('General');
      const hasLoc = db.prepare('SELECT COUNT(*) AS c FROM locations').get().c;
      if (hasLoc === 0) db.prepare('INSERT INTO locations (code, name) VALUES (?, ?)').run('HQ', 'Main Store');
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('gs.base', '1')").run();
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export default { createDb, migrate };
