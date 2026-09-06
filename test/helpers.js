import { Store } from '../src/store.js';

export function createTestStore() {
  const store = new Store(':memory:');
  seed(store.db);
  return store;
}

const products = [
  ['SKU-001', '8901001001', 'Whole Milk 1L', 'Dairy', 250, 170, 0.08],
  ['SKU-002', '8901001002', 'White Bread Loaf', 'Bakery', 180, 120, 0.08],
  ['SKU-003', '8901001003', 'Free-Range Eggs (6)', 'Dairy', 380, 290, 0.08],
];

function seed(db) {
  const insertProduct = db.prepare(
    'INSERT INTO products (sku, barcode, name, category, price_cents, cost_cents, tax_rate) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertInventory = db.prepare('INSERT INTO inventory (product_id, quantity, reorder_level) VALUES (?, ?, ?)');
  for (const [sku, barcode, name, category, price, cost, tax] of products) {
    const res = insertProduct.run(sku, barcode, name, category, price, cost, tax);
    insertInventory.run(res.lastInsertRowid, 100, 10);
  }

  const insertCustomer = db.prepare(
    'INSERT INTO customers (name, phone, email, loyalty_points, total_spent_cents) VALUES (?, ?, ?, ?, ?)'
  );
  insertCustomer.run('Walk-In Customer', null, null, 0, 0);
  insertCustomer.run('Maria Gomez', '+15551234567', 'maria@example.com', 250, 123450);

  const insertSupplier = db.prepare('INSERT INTO suppliers (name, phone, email) VALUES (?, ?, ?)');
  insertSupplier.run('Fresh Farms Wholesale', '+15550001111', 'sales@freshfarms.com');

  const accounts = [
    ['1000', 'Cash', 'asset'],
    ['1100', 'Accounts Receivable', 'asset'],
    ['1200', 'Inventory', 'asset'],
    ['2000', 'Accounts Payable', 'liability'],
    ['3000', 'Owner Equity', 'equity'],
    ['4000', 'Sales Revenue', 'revenue'],
    ['4100', 'Cost of Goods Sold', 'expense'],
    ['4200', 'Tax Payable (Sales)', 'liability'],
    ['4300', 'Operating Expenses', 'expense'],
  ];
  const insertAccount = db.prepare('INSERT OR IGNORE INTO accounts (code, name, type) VALUES (?, ?, ?)');
  for (const a of accounts) insertAccount.run(...a);

  // Seed employees for HR tests
  const insertEmployee = db.prepare(
    'INSERT INTO employees (name, role, department, hourly_rate_cents, email, phone, hire_date) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insertEmployee.run('Alice Johnson', 'Cashier', 'Retail', 1500, 'alice@example.com', '+15551110001', '2025-01-15');
  insertEmployee.run('Bob Smith', 'Manager', 'Retail', 2500, 'bob@example.com', '+15551110002', '2024-06-01');

  // Seed benefits for one employee
  const insertBenefit = db.prepare(
    'INSERT INTO benefits (employee_id, plan_name, provider, monthly_cost_cents, employer_contribution_cents, status) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insertBenefit.run(1, 'Gold', 'Acme Health', 50000, 30000, 'active');
}

export function productIds(store) {
  return store.listProducts().map(p => p.id);
}

export function productByName(store, name) {
  return store.listProducts().find(p => p.name === name);
}
