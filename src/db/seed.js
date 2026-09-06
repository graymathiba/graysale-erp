import { createDb, migrate } from './database.js';

const db = createDb();
migrate(db);

const products = [
  ['SKU-001', '8901001001', 'Whole Milk 1L', 'Dairy', 250, 170, 0.08],
  ['SKU-002', '8901001002', 'White Bread Loaf', 'Bakery', 180, 120, 0.08],
  ['SKU-003', '8901001003', 'Free-Range Eggs (6)', 'Dairy', 380, 290, 0.08],
  ['SKU-004', '8901001004', 'Ground Coffee 250g', 'Beverages', 950, 700, 0.08],
  ['SKU-005', '8901001005', 'Breakfast Cereal 500g', 'Grocery', 460, 340, 0.08],
  ['SKU-006', '8901001006', 'Bananas (per kg)', 'Produce', 200, 140, 0.08],
  ['SKU-007', '8901001007', 'Apples (per kg)', 'Produce', 320, 230, 0.08],
  ['SKU-008', '8901001008', 'Chicken Breast 1kg', 'Meat', 1200, 900, 0.08],
  ['SKU-009', '8901001009', 'Pasta Penne 500g', 'Grocery', 210, 150, 0.08],
  ['SKU-010', '8901001010', 'Tomato Sauce 400g', 'Grocery', 280, 200, 0.08],
  ['SKU-011', '8901001011', 'Orange Juice 1L', 'Beverages', 420, 310, 0.08],
  ['SKU-012', '8901001012', 'Cheddar Cheese 250g', 'Dairy', 560, 420, 0.08],
  ['SKU-013', '8901001013', 'Instant Noodles (5pk)', 'Grocery', 340, 250, 0.08],
  ['SKU-014', '8901001014', 'Olive Oil 500ml', 'Grocery', 780, 580, 0.08],
  ['SKU-015', '8901001015', 'Granola Bar (10pk)', 'Snacks', 520, 390, 0.08]
];

const insertProduct = db.prepare(
  'INSERT INTO products (sku, barcode, name, category, price_cents, cost_cents, tax_rate) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const insertInventory = db.prepare('INSERT INTO inventory (product_id, quantity, reorder_level) VALUES (?, ?, ?)');

for (const [sku, barcode, name, category, price, cost, tax] of products) {
  const res = insertProduct.run(sku, barcode, name, category, price, cost, tax);
  insertInventory.run(res.lastInsertRowid, Math.floor(Math.random() * 80) + 20, 15);
}

const insertCustomer = db.prepare(
  'INSERT INTO customers (name, phone, email, loyalty_points, total_spent_cents) VALUES (?, ?, ?, ?, ?)'
);
const customers = [
  ['Walk-In Customer', null, null, 0, 0],
  ['Maria Gomez', '+15551234567', 'maria@example.com', 250, 123450],
  ['James Lee', '+15559876543', 'james@example.com', 120, 87650],
  ['Amina Yusuf', '+15551112233', 'amina@example.com', 480, 234000]
];
for (const c of customers) insertCustomer.run(...c);

const insertSupplier = db.prepare('INSERT INTO suppliers (name, phone, email) VALUES (?, ?, ?)');
const suppliers = [
  ['Fresh Farms Wholesale', '+15550001111', 'sales@freshfarms.com'],
  ['Distributor Central', '+15550002222', 'orders@distributorcentral.com']
];
for (const s of suppliers) insertSupplier.run(...s);

const accounts = [
  ['1000', 'Cash', 'asset'],
  ['1100', 'Accounts Receivable', 'asset'],
  ['1200', 'Inventory', 'asset'],
  ['2000', 'Accounts Payable', 'liability'],
  ['3000', 'Owner Equity', 'equity'],
  ['3100', 'Retained Earnings', 'equity'],
  ['4000', 'Sales Revenue', 'revenue'],
  ['4100', 'Cost of Goods Sold', 'expense'],
  ['4200', 'Tax Payable (Sales)', 'liability'],
  ['4300', 'Operating Expenses', 'expense']
];
const insertAccount = db.prepare('INSERT INTO accounts (code, name, type) VALUES (?, ?, ?)');
for (const a of accounts) insertAccount.run(...a);

db.close();
console.log('Database seeded successfully.');
