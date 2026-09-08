import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
const BASE = 3000 + Math.floor(Math.random() * 4000 + 1);

let server, port, dbPath;

async function start() {
  port = BASE;
  dbPath = path.join(os.tmpdir(), `erp-e2e-${randomBytes(6).toString('hex')}.db`);
  server = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Wait for the HTTP listener (console line "SuperMart POS running at ...").
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server boot timeout')), 15000);
    server.stdout.on('data', (d) => {
      if (String(d).includes('running at')) { clearTimeout(t); resolve(); }
    });
    server.stderr.on('data', () => {});
    server.on('exit', (code) => { clearTimeout(t); reject(new Error(`server exited early: ${code}`)); });
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.on('exit', () => resolve());
    server.kill('SIGTERM');
    setTimeout(resolve, 1500);
  });
}

async function api(method, p, body, token) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: res.status, data };
}

const before = test;
test('boot', async () => { await start(); });

before('login as default admin', async () => {
  const r = await api('POST', '/api/v1/auth/login', { username: 'admin', password: 'Admin123' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.ok, true);
  assert.ok(r.data.token, 'login should return a token');
  global.__adminToken = r.data.token;
  assert.ok(r.data.user.id, 'admin has tenant-scoped user id');
});

test('GET /api/v1/auth/me works with bearer token', async () => {
  const r = await api('GET', '/api/v1/auth/me', null, global.__adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.data.user.username, 'admin');
});

test('POST /api/v1/users/create assigns the current tenant (owner user)', async () => {
  const r = await api('POST', '/api/v1/users/create',
    { username: 'owner1', password: 'OwnerPass123', fullName: 'Tenant Owner', role: 'owner' },
    global.__adminToken);
  assert.equal(r.status, 201, JSON.stringify(r));
  assert.ok(r.data.id, 'owner created');
  const login = await api('POST', '/api/v1/auth/login', { username: 'owner1', password: 'OwnerPass123' });
  assert.equal(login.data.ok, true);
  global.__ownerToken = login.data.token;
});

test('GET /api/v1/license/status returns the seeded tenant', async () => {
  const r = await api('GET', '/api/v1/license/status', null, global.__ownerToken);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.status, 'ACTIVE');
  assert.ok(r.data.tenantId);
  assert.equal(r.data.activationRequired, false);
});

test('PUT /api/v1/company-settings persists business + banking', async () => {
  const r = await api('PUT', '/api/v1/company-settings',
    { company_name: 'Acme Retail', address: '1 Main St', telephone: '555-0100', banking_details: [{ bank: 'Z', acct: '123' }] },
    global.__ownerToken);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.company_name, 'Acme Retail');
  const get = await api('GET', '/api/v1/company-settings', null, global.__ownerToken);
  assert.equal(get.status, 200);
  assert.equal(get.data.address, '1 Main St');
  assert.equal(get.data.banking_details.length, 1);
});

test('tenant owner can self-edit profile (owner-identifier + company + password)', async () => {
  const before = await api('GET', '/api/v1/tenant/profile', null, global.__ownerToken);
  assert.equal(before.status, 200);
  assert.equal(before.data.owner_username, 'owner1');
  assert.equal(before.data.status, 'ACTIVE');

  // Changing the password requires the current password.
  const badPw = await api('PUT', '/api/v1/tenant/profile',
    { company_name: 'Acme Retail Ltd', new_password: 'BrandNew123', current_password: 'wrong' },
    global.__ownerToken);
  assert.equal(badPw.status, 400);
  assert.match(badPw.data.error, /INVALID_CURRENT_PASSWORD/);

  const r = await api('PUT', '/api/v1/tenant/profile',
    { company_name: 'Acme Retail Ltd', owner_email: 'owner@acme.com', new_password: 'BrandNew123', current_password: 'OwnerPass123' },
    global.__ownerToken);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.company_name, 'Acme Retail Ltd');
  assert.equal(r.data.companyName ? r.data.companyName : r.data.company_name, 'Acme Retail Ltd');
});

test('non-owner cannot edit tenant profile', async () => {
  const r = await api('POST', '/api/v1/users/create',
    { username: 'cashier1', password: 'Cashier123', fullName: 'Cashier', role: 'cashier' },
    global.__adminToken);
  const login = await api('POST', '/api/v1/auth/login', { username: 'cashier1', password: 'Cashier123' });
  const r2 = await api('PUT', '/api/v1/tenant/profile', { company_name: 'Nope' }, login.data.token);
  assert.equal(r2.status, 403);
  assert.match(r2.data.error, /OWNER_ONLY/);
});

test('POST /api/v1/sync/sales is idempotent by local id', async () => {
  // The owner changed their password in the profile test, which invalidated
  // every prior session — re-authenticate with the new password.
  const relogin = await api('POST', '/api/v1/auth/login', { username: 'owner1', password: 'BrandNew123' });
  assert.equal(relogin.data.ok, true);
  const ownerToken = relogin.data.token;

  const sale = {
    id: 'pos-0001',
    total_cents: 1250,
    subtotal_cents: 1250,
    tax_cents: 100,
    payment_method: 'cash',
    created_at: '2026-09-08T10:00:00.000Z',
    lines: [{ product_id: 1, product_name: 'Whole Milk 1L', price_cents: 250, qty: 5 }],
  };
  const first = await api('POST', '/api/v1/sync/sales', { sales: [sale] }, ownerToken);
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.data.syncedIds.length, 1);
  assert.equal(first.data.duplicates.length, 0);

  // Re-sending the same local id must not create a second receipt.
  const second = await api('POST', '/api/v1/sync/sales', { sales: [sale] }, ownerToken);
  assert.equal(second.status, 200);
  assert.equal(second.data.syncedIds.length, 0);
  assert.deepEqual(second.data.duplicates, ['pos-0001']);

  const batch = await api('POST', '/api/v1/sync/sales', {
    sales: [
      { ...sale, id: 'pos-0002', total_cents: 999 },
      { ...sale, id: 'pos-0003', total_cents: 888 },
    ],
  }, ownerToken);
  assert.deepEqual(batch.data.syncedIds.sort(), ['pos-0002', 'pos-0003']);
});

test('dashboard still aggregates real sales after sync', async () => {
  const relogin = await api('POST', '/api/v1/auth/login', { username: 'owner1', password: 'BrandNew123' });
  const ownerToken = relogin.data.token;
  const r = await api('GET', '/api/v1/dashboard', null, ownerToken);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.ok(typeof r.data.today === 'object');
  assert.ok(Array.isArray(r.data.byDay));
});

test('bootstrapped admin is a super admin with Control Tower access', async () => {
  const adminRelogin = await api('POST', '/api/v1/auth/login', { username: 'admin', password: 'Admin123' });
  assert.equal(adminRelogin.data.user.isSuperAdmin, true, 'default admin carries the global flag');
  assert.equal(adminRelogin.data.tenant, null, 'super admins operate outside tenant boundaries');
  const adminToken = adminRelogin.data.token;

  const tenants = await api('GET', '/api/v1/superadmin/tenants', null, adminToken);
  assert.equal(tenants.status, 200, JSON.stringify(tenants));
  assert.ok(Array.isArray(tenants.data));

  const keys = await api('GET', '/api/v1/superadmin/keys', null, adminToken);
  assert.equal(keys.status, 200);

  const overview = await api('GET', '/api/v1/superadmin/overview', null, adminToken);
  assert.equal(overview.status, 200);
  assert.ok('activeCompanies' in overview.data);

  // Control Tower credential management: the tenant owner (owner1 here, created
  // earlier) is force-reset without the current password.
  const tenantId = tenants.data[0].id;
  const update = await api('PUT', `/api/v1/superadmin/tenants/${tenantId}`,
    { company_name: 'Acme Retail Ltd', owner_email: 'owner@acme.com', new_password: 'ForceReset123' },
    adminToken);
  assert.equal(update.status, 200, JSON.stringify(update));
  const ownerLogin = await api('POST', '/api/v1/auth/login', { username: 'owner1', password: 'ForceReset123' });
  assert.equal(ownerLogin.data.ok, true, 'forced password takes effect');

  const me = await api('GET', '/api/v1/auth/me', null, adminToken);
  assert.equal(me.status, 200);
  assert.equal(me.data.user.username, 'admin');
  assert.equal(me.data.user.isSuperAdmin, true);
});

before('teardown', async () => {
  await stop();
  if (dbPath) { try { fs.unlinkSync(dbPath); } catch {} }
});