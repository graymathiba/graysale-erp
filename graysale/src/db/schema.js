// Schema definition + default seed data. Money is INTEGER cents everywhere.
const SCHEMA = `
PRAGMA foreign_keys = ON;

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

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'cashier',
  location_id INTEGER REFERENCES locations(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  username TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS product_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES product_categories(id),
  unit TEXT NOT NULL DEFAULT 'each',
  cost_cents INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL DEFAULT 0,
  tax_class_id INTEGER REFERENCES tax_classes(id),
  reorder_level INTEGER NOT NULL DEFAULT 0,
  serial_tracked INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  description TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  manufacturer_part_no TEXT NOT NULL DEFAULT '',
  hs_code TEXT NOT NULL DEFAULT '',
  bin_location TEXT NOT NULL DEFAULT '',
  min_stock INTEGER NOT NULL DEFAULT 0,
  max_stock INTEGER NOT NULL DEFAULT 0,
  lead_time_days INTEGER NOT NULL DEFAULT 0,
  warranty_days INTEGER NOT NULL DEFAULT 0,
  weight_grams INTEGER NOT NULL DEFAULT 0,
  length_mm INTEGER NOT NULL DEFAULT 0,
  width_mm INTEGER NOT NULL DEFAULT 0,
  height_mm INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product_stock (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  qty_on_hand INTEGER NOT NULL DEFAULT 0,
  qty_reserved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL,
  type TEXT NOT NULL, -- SALE, REFUND, RECEIPT, PO, ADJUST, MOVE_OUT, MANUAL_IN
  ref_type TEXT,
  ref_id INTEGER,
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  tax_id TEXT,
  credit_limit_cents INTEGER NOT NULL DEFAULT 0,
  loyalty_points INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  tax_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- orders: SALE / REFUND / LAYAWAY / QUOTE
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN, PAID, COMPLETED, VOID, CONVERTED
  customer_id INTEGER REFERENCES customers(id),
  user_id INTEGER REFERENCES users(id),
  location_id INTEGER REFERENCES locations(id),
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

CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
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
  order_id INTEGER REFERENCES orders(id),
  kind TEXT NOT NULL DEFAULT 'INVOICE', -- INVOICE, CREDIT_NOTE
  date TEXT NOT NULL,
  due_date TEXT,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN, PARTIAL, PAID, VOID
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

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT UNIQUE NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT, ORDERED, PARTIAL, RECEIVED, VOID
  expected_date TEXT,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS po_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL,
  qty_received INTEGER NOT NULL DEFAULT 0,
  unit_cost_cents INTEGER NOT NULL,
  tax_class_id INTEGER REFERENCES tax_classes(id),
  line_total_cents INTEGER NOT NULL DEFAULT 0
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
  kind TEXT NOT NULL, -- RECEIPT, EXPENSE
  party_type TEXT NOT NULL, -- CUSTOMER, SUPPLIER
  party_id INTEGER NOT NULL,
  method TEXT NOT NULL, -- CASH, CARD, MOBILE, BANK, CREDIT_NOTE
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
  invoice_type TEXT NOT NULL, -- AR, AP
  invoice_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL, -- asset, liability, equity, revenue, expense
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT UNIQUE NOT NULL,
  date TEXT NOT NULL,
  reference TEXT,
  description TEXT,
  user_id INTEGER REFERENCES users(id),
  posted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit_cents INTEGER NOT NULL DEFAULT 0,
  credit_cents INTEGER NOT NULL DEFAULT 0
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
  amount_cents INTEGER NOT NULL, -- + in / - out
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
  location_id INTEGER REFERENCES locations(id),
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

CREATE TABLE IF NOT EXISTS product_barcodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  barcode TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'CODE128',
  is_primary INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(barcode)
);

CREATE TABLE IF NOT EXISTS product_price_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tier_name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  min_qty INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(product_id, tier_name)
);

CREATE TABLE IF NOT EXISTS product_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  batch_no TEXT NOT NULL,
  manufacture_date TEXT,
  expiry_date TEXT,
  qty_on_hand INTEGER NOT NULL DEFAULT 0,
  location TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_id, batch_no)
);

CREATE TABLE IF NOT EXISTS product_uom (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  uom_name TEXT NOT NULL,
  conversion_factor REAL NOT NULL DEFAULT 1.0,
  is_base INTEGER NOT NULL DEFAULT 0,
  price_override_cents INTEGER,
  UNIQUE(product_id, uom_name)
);

CREATE TABLE IF NOT EXISTS product_bundles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bundle_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  component_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty_required INTEGER NOT NULL DEFAULT 1,
  UNIQUE(bundle_product_id, component_product_id)
);
`;

const DEFAULT_SETTINGS = [
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

const CHART_OF_ACCOUNTS = [
  ['1000', 'Cash on Hand', 'asset'],
  ['1010', 'Bank – Main', 'asset'],
  ['1100', 'Accounts Receivable', 'asset'],
  ['1200', 'Inventory', 'asset'],
  ['1490', 'Input Tax (Purchases)', 'asset'],
  ['2010', 'Accounts Payable', 'liability'],
  ['2100', 'Output Tax (Sales)', 'liability'],
  ['2200', 'Customer Deposits (Layaway)', 'liability'],
  ['3000', "Owner's Equity", 'equity'],
  ['3200', 'Retained Earnings', 'equity'],
  ['4000', 'Sales Revenue', 'revenue'],
  ['4100', 'Sales Discounts', 'revenue'],
  ['4200', 'Sales Returns', 'revenue'],
  ['4600', 'Other Income', 'revenue'],
  ['5100', 'Cost of Goods Sold', 'expense'],
  ['6100', 'Salaries & Wages', 'expense'],
  ['6200', 'Rent', 'expense'],
  ['6300', 'Utilities', 'expense'],
  ['6400', 'Operating Expenses', 'expense'],
  ['6500', 'Bank Charges', 'expense'],
];

const ACCOUNT = Object.fromEntries(CHART_OF_ACCOUNTS.map(([code, name]) => [name.replace(/[^A-Za-z]/g, ''), code]));
// Convenient named codes used by the auto-posting engine.
export const ACC = {
  CASH: '1000',
  BANK: '1010',
  AR: '1100',
  INVENTORY: '1200',
  INPUT_TAX: '1490',
  AP: '2010',
  OUTPUT_TAX: '2100',
  DEPOSITS: '2200',
  EQUITY: '3000',
  RETAINED: '3200',
  SALES_REVENUE: '4000',
  SALES_DISCOUNTS: '4100',
  SALES_RETURNS: '4200',
  OTHER_INCOME: '4600',
  COGS: '5100',
  SALARIES: '6100',
  RENT: '6200',
  UTILITIES: '6300',
  OPERATING_EXP: '6400',
  BANK_CHARGES: '6500',
};

export async function runMigrations(db) {
  db.exec(SCHEMA);

  // Seed defaults only once.
  const seeded = db.prepare('SELECT value FROM settings WHERE key = ?').get('schema.version');
  if (!seeded) {
    db.exec('BEGIN');
    try {
      for (const [key, value] of DEFAULT_SETTINGS) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
      }
      for (const [code, name, type] of CHART_OF_ACCOUNTS) {
        db.prepare('INSERT INTO accounts (code, name, type) VALUES (?, ?, ?)').run(code, name, type);
      }
      for (const [name, rate] of [['Zero Rated', 0], ['Standard', 1500], ['Reduced', 750]]) {
        db.prepare('INSERT INTO tax_classes (name, rate_bps) VALUES (?, ?)').run(name, rate);
      }
      db.prepare("INSERT INTO locations (code, name) VALUES (?, ?)").run('HQ', 'Main Store');
      db.prepare("INSERT INTO settings (key, value) VALUES ('schema.version', '1')").run();
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // Upgrade path: add new default settings for existing DBs missing them.
  const v = db.prepare("SELECT value FROM settings WHERE key = 'schema.version'").get();
  const version = v ? Number(v.value) : 0;
  if (version < 2) {
    db.exec('BEGIN');
    try {
      for (const [key, value] of DEFAULT_SETTINGS) {
        db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
      }
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema.version', '2')").run();
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
    }
  }
  if (version < 3) {
    // v3: customer tax_id for tax compliance / layby records.
    try {
      db.exec('ALTER TABLE customers ADD COLUMN tax_id TEXT');
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema.version', '3')").run();
    } catch (e) { /* column may already exist */ }
  }
  if (version < 5) {
    // v5: industry-grade product fields + new tables.
    const v5cols = [
      "ALTER TABLE products ADD COLUMN description TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE products ADD COLUMN brand TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE products ADD COLUMN manufacturer_part_no TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE products ADD COLUMN hs_code TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE products ADD COLUMN bin_location TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE products ADD COLUMN min_stock INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE products ADD COLUMN max_stock INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE products ADD COLUMN lead_time_days INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE products ADD COLUMN warranty_days INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE products ADD COLUMN weight_grams INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE products ADD COLUMN length_mm INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE products ADD COLUMN width_mm INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE products ADD COLUMN height_mm INTEGER NOT NULL DEFAULT 0",
    ];
    db.exec('BEGIN');
    try {
      for (const sql of v5cols) { try { db.exec(sql); } catch { /* column exists */ } }
      db.exec(`CREATE TABLE IF NOT EXISTS product_barcodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        barcode TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'CODE128', is_primary INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(barcode))`);
      db.exec(`CREATE TABLE IF NOT EXISTS product_price_tiers (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        tier_name TEXT NOT NULL, price_cents INTEGER NOT NULL, min_qty INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1, UNIQUE(product_id, tier_name))`);
      db.exec(`CREATE TABLE IF NOT EXISTS product_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        batch_no TEXT NOT NULL, manufacture_date TEXT, expiry_date TEXT, qty_on_hand INTEGER NOT NULL DEFAULT 0,
        location TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(product_id, batch_no))`);
      db.exec(`CREATE TABLE IF NOT EXISTS product_uom (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        uom_name TEXT NOT NULL, conversion_factor REAL NOT NULL DEFAULT 1.0, is_base INTEGER NOT NULL DEFAULT 0,
        price_override_cents INTEGER, UNIQUE(product_id, uom_name))`);
      db.exec(`CREATE TABLE IF NOT EXISTS product_bundles (
        id INTEGER PRIMARY KEY AUTOINCREMENT, bundle_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        component_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        qty_required INTEGER NOT NULL DEFAULT 1, UNIQUE(bundle_product_id, component_product_id))`);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema.version', '5')").run();
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

export default { runMigrations };