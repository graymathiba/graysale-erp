import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './helpers.js';
import { LicensingService } from '../src/licensing/index.js';
import { AuthService } from '../src/auth.js';

function newCtx() {
  const store = createTestStore();
  const auth = new AuthService(store);
  return { store, auth, licensing: new LicensingService(store.db, auth) };
}

// Ensure an owner user exists for the tenant so self-service works.
function ensureOwner(store) {
  const tenant = store.db.prepare('SELECT id FROM tenants ORDER BY created_at LIMIT 1').get();
  let owner = store.db.prepare("SELECT * FROM users WHERE tenant_id = ? AND role = 'owner' LIMIT 1").get(tenant.id);
  if (!owner) {
    store.db.prepare(
      "INSERT INTO users (username, password_hash, full_name, role, tenant_id) VALUES ('owner1', 'x', 'Owner', 'owner', ?)"
    ).run(tenant.id);
    owner = store.db.prepare("SELECT * FROM users WHERE tenant_id = ? AND role = 'owner' LIMIT 1").get(tenant.id);
  }
  return { tenant, owner };
}

// ---------------- V6 migration ----------------
test('V6: users table has tenant_id column', () => {
  const { store } = newCtx();
  const cols = store.db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  assert.ok(cols.includes('tenant_id'), 'users should have a tenant_id column');
});

test('V6 backfill: pre-existing users map to the seeded tenant', async () => {
  const { createDb, migrate } = await import('../src/db/database.js');
  const raw = createDb(':memory:');
  // Pre-migration state: a V1-shaped users table + the V5 tenants table.
  raw.prepare(
    `CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, full_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cashier', active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`
  ).run();
  raw.prepare(
    `CREATE TABLE tenants (
      id TEXT PRIMARY KEY, company_name TEXT NOT NULL, owner_email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE', license_key TEXT, license_expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`
  ).run();
  raw.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('pre', 'x', 'Pre', 'owner');").run();
  raw.prepare("INSERT INTO tenants (id, company_name, owner_email, status) VALUES ('t-backfill', 'X', '', 'ACTIVE');").run();
  migrate(raw);
  assert.equal(raw.prepare('SELECT tenant_id FROM users WHERE username = ?').get('pre').tenant_id, 't-backfill');
});

test('V6: company_settings table exists', () => {
  const { store } = newCtx();
  store.db.prepare('INSERT INTO company_settings (id, tenant_id, company_name) VALUES (1, ?, ?)')
    .run(store.db.prepare('SELECT id FROM tenants LIMIT 1').get().id, 'Acme');
  const row = store.db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  assert.equal(row.company_name, 'Acme');
});

// ---------------- Tenant self-service ----------------
test('profile.get returns tenant + owner + business defaults', () => {
  const { store, licensing } = newCtx();
  ensureOwner(store);
  const p = licensing.profile.get(null);
  assert.ok(p.tenantId);
  assert.equal(p.status, 'ACTIVE');
  assert.equal(p.owner_username, 'owner1');
  assert.equal(p.address, '');
});

test('profile.update lets the owner change username + email', () => {
  const { store, licensing, auth } = newCtx();
  const { tenant, owner } = ensureOwner(store);
  const actor = auth.publicUser(owner);
  const updated = licensing.profile.update(
    { company_name: 'NewCo', owner_email: 'new@co.com', owner_username: 'newowner' },
    tenant.id, actor
  );
  assert.equal(updated.company_name, 'NewCo');
  assert.equal(updated.owner_email, 'new@co.com');
  assert.equal(updated.owner_username, 'newowner');
});

test('profile.update requires the current password to change password', () => {
  const { store, licensing, auth } = newCtx();
  const { tenant, owner } = ensureOwner(store);
  const actor = auth.publicUser(owner);
  assert.throws(() =>
    licensing.profile.update({ new_password: 'NewPass123' }, tenant.id, actor),
    /CURRENT_PASSWORD_REQUIRED/
  );
});

test('profile.update is owner-only (non-owner forbidden)', () => {
  const { store, licensing } = newCtx();
  const { tenant } = ensureOwner(store);
  const cashier = { id: 99999, username: 'cashier', role: 'cashier' };
  assert.throws(() =>
    licensing.profile.update({ company_name: 'X' }, tenant.id, cashier),
    /OWNER_ONLY/
  );
});

test('profile.adminUpdate force-resets password without current password', () => {
  const { store, licensing, auth } = newCtx();
  const { tenant, owner } = ensureOwner(store);
  const admin = { id: 1, username: 'super' };
  const p = licensing.profile.adminUpdate(tenant.id, { new_password: 'ForcePass123' }, admin);
  assert.ok(p.owner_user_id);
  const stored = store.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(owner.id);
  assert.ok(stored.password_hash.startsWith('scrypt$'));
});

// ---------------- Company settings ----------------
test('company.get returns defaults when no row exists', () => {
  const { licensing } = newCtx();
  const cs = licensing.company.get(null);
  assert.equal(cs.company_name, '');
  assert.deepEqual(cs.banking_details, []);
});

test('company.update persists business + banking details', () => {
  const { licensing } = newCtx();
  const cs = licensing.company.update({
    company_name: 'Acme', address: '1 Main St', telephone: '555',
    banking_details: [{ bank: 'ZB', acct: '123' }],
  }, null);
  assert.equal(cs.company_name, 'Acme');
  assert.equal(cs.address, '1 Main St');
  assert.deepEqual(cs.banking_details, [{ bank: 'ZB', acct: '123' }]);
});

// ---------------- Admin as de-facto owner ----------------
// The merged ERP stores the tenant operator as role 'admin' (the standalone
// build used an explicit 'owner' role). When no owner-role account exists,
// findOwner resolves the tenant's first admin so self-service still works.

test('findOwner falls back to the tenant admin when no owner-role user exists', async () => {
  const { store } = newCtx();
  const tenant = store.db.prepare('SELECT id FROM tenants LIMIT 1').get();
  store.db.prepare(
    "INSERT INTO users (username, password_hash, full_name, role, tenant_id) VALUES ('bizadmin', 'x', 'Biz Admin', 'admin', ?)"
  ).run(tenant.id);
  const { findOwner } = await import('../src/licensing/owner.js');
  const owner = findOwner(store.db, tenant.id);
  assert.equal(owner.username, 'bizadmin');
  assert.equal(owner.role, 'admin');
});

test('profile resolves the admin owner and lets them update the tenant', () => {
  const { store, licensing, auth } = newCtx();
  const tenant = store.db.prepare('SELECT id FROM tenants LIMIT 1').get();
  const admin = store.db.prepare(
    "INSERT INTO users (username, password_hash, full_name, role, tenant_id) VALUES ('bizadmin', 'x', 'Biz Admin', 'admin', ?)"
  ).run(tenant.id);
  const adminUser = store.db.prepare('SELECT * FROM users WHERE id = ?').get(admin.lastInsertRowid);
  const actor = auth.publicUser(adminUser);
  const p = licensing.profile.get(null);
  assert.equal(p.owner_username, 'bizadmin');
  const updated = licensing.profile.update(
    { company_name: 'EnCore', owner_email: 'owner@encore.com', owner_username: 'bizadmin' },
    tenant.id, actor
  );
  assert.equal(updated.company_name, 'EnCore');
});

test('admin owner cannot change password without the current password', () => {
  const { store, licensing, auth } = newCtx();
  const tenant = store.db.prepare('SELECT id FROM tenants LIMIT 1').get();
  const admin = store.db.prepare(
    "INSERT INTO users (username, password_hash, full_name, role, tenant_id) VALUES ('bizadmin', 'x', 'Biz Admin', 'admin', ?)"
  ).run(tenant.id);
  const adminUser = store.db.prepare('SELECT * FROM users WHERE id = ?').get(admin.lastInsertRowid);
  const actor = auth.publicUser(adminUser);
  assert.throws(() =>
    licensing.profile.update({ new_password: 'AdminPass123' }, tenant.id, actor),
    /CURRENT_PASSWORD_REQUIRED/
  );
});

// ---------------- Tenant update (Control Tower) ----------------
test('TenantsService.update honors owner_username / address / new_password', () => {
  const { store, licensing } = newCtx();
  const { tenant } = ensureOwner(store);
  const t = licensing.tenants.update(tenant.id, {
    companyName: 'Edited', ownerEmail: 'e@e.com',
    owner_username: 'renamed', address: '10 Oak', new_password: 'AdminPass123',
  });
  assert.equal(t.company_name, 'Edited');
  const owner = store.db.prepare("SELECT * FROM users WHERE tenant_id = ? AND role = 'owner' LIMIT 1").get(tenant.id);
  assert.equal(owner.username, 'renamed');
  assert.ok(owner.password_hash.startsWith('scrypt$'));
  // _decorate returns the owner username + active user count now that tenant_id exists
  assert.equal(t.owner_username, 'renamed');
  assert.ok(Number(t.activeUsers) >= 1);
});

test('TenantsService._decorate resolves owner username via users.tenant_id', () => {
  const { licensing, store } = newCtx();
  const { tenant } = ensureOwner(store);
  const listed = licensing.tenants.list({})[0];
  // The seeded tenant is the only one; it should expose owner_username
  assert.ok('owner_username' in listed);
  assert.equal(typeof listed.activeUsers, 'number');
});
