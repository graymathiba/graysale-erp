import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './helpers.js';
import { AuthService, ROLES, can, roleRank, hashPassword, verifyPassword, validatePassword, CAP_RANK } from '../src/auth.js';

function newAuth() {
  const store = createTestStore();
  const auth = new AuthService(store);
  return { store, auth };
}

test('hashPassword produces a verifiable scrypt hash', () => {
  const hash = hashPassword('secret123');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(verifyPassword('secret123', hash), true);
  assert.equal(verifyPassword('wrong', hash), false);
  assert.equal(verifyPassword('secret123', 'garbage'), false);
});

test('validatePassword rejects short passwords', () => {
  assert.equal(validatePassword('abc'), false);
  assert.equal(validatePassword('Ab1'), false);
  assert.equal(validatePassword(''), false);
});

test('validatePassword rejects passwords without uppercase', () => {
  assert.equal(validatePassword('alllower1'), false);
});

test('validatePassword rejects passwords without lowercase', () => {
  assert.equal(validatePassword('ALLUPPER1'), false);
});

test('validatePassword rejects passwords without digit', () => {
  assert.equal(validatePassword('NoDigitsHere'), false);
});

test('validatePassword accepts strong passwords', () => {
  assert.equal(validatePassword('Admin123'), true);
  assert.equal(validatePassword('P@ssw0rd!'), true);
  assert.equal(validatePassword('Abcdefg1'), true);
});

test('validatePassword rejects non-string input', () => {
  assert.equal(validatePassword(null), false);
  assert.equal(validatePassword(undefined), false);
  assert.equal(validatePassword(12345), false);
});

test('default admin is created only when no users exist', () => {
  const { auth } = newAuth();
  assert.equal(auth.ensureDefaultAdmin(), true);
  assert.equal(auth.ensureDefaultAdmin(), false); // second call no-op
  const users = auth.listUsers();
  assert.equal(users.length, 1);
  assert.equal(users[0].role, ROLES.ADMIN);
});

test('login succeeds with valid credentials and issues a working token', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const res = auth.login({ username: 'admin', password: 'Admin123' });
  assert.equal(res.ok, true);
  assert.ok(res.token);
  assert.equal(res.user.role, ROLES.ADMIN);
  const user = auth.userForToken(res.token);
  assert.equal(user.username, 'admin');
});

test('login fails with wrong credentials and does not create sessions', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const res = auth.login({ username: 'admin', password: 'nope' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'INVALID_CREDENTIALS');
  assert.equal(auth.userForToken('anything'), null);
});

test('logout invalidates the session token', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const { token } = auth.login({ username: 'admin', password: 'Admin123' });
  assert.ok(auth.userForToken(token));
  auth.logout(token);
  assert.equal(auth.userForToken(token), null);
});

test('unknown or expired tokens resolve to null', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const { token } = auth.login({ username: 'admin', password: 'Admin123' });
  assert.equal(auth.userForToken('bogus-token'), null);
  // Force session expiry via direct DB manipulation
  const sess = auth.store.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  auth.store.db.prepare('UPDATE sessions SET expires_at = datetime(\'now\', \'-1 hour\') WHERE token = ?').run(token);
  assert.equal(auth.userForToken(token), null);
});

test('rate limiting triggers after 5 failed logins', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  for (let i = 0; i < 5; i++) {
    const res = auth.login({ username: 'admin', password: 'wrong' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'INVALID_CREDENTIALS');
  }
  const rateLimited = auth.login({ username: 'admin', password: 'wrong' });
  assert.equal(rateLimited.ok, false);
  assert.equal(rateLimited.error, 'RATE_LIMITED');
});

test('rate limiting is per-username', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  for (let i = 0; i < 5; i++) {
    auth.login({ username: 'admin', password: 'wrong' });
  }
  const rateLimited = auth.login({ username: 'admin', password: 'wrong' });
  assert.equal(rateLimited.error, 'RATE_LIMITED');
  // Different username is not rate-limited
  const other = auth.login({ username: 'nobody', password: 'wrong' });
  assert.equal(other.error, 'INVALID_CREDENTIALS');
});

test('successful login clears rate limit', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  for (let i = 0; i < 4; i++) {
    auth.login({ username: 'admin', password: 'wrong' });
  }
  auth.login({ username: 'admin', password: 'Admin123' });
  // Should not be rate-limited after successful login
  const res = auth.login({ username: 'admin', password: 'wrong' });
  assert.equal(res.error, 'INVALID_CREDENTIALS');
});

test('role hierarchy: manager can do cashier + manager actions, not admin', () => {
  assert.equal(can('cashier', 'pos.checkout'), true);
  assert.equal(can('cashier', 'backup.run'), false);
  assert.equal(can('manager', 'backup.run'), true);
  assert.equal(can('manager', 'users.manage'), false);
  assert.equal(can('admin', 'users.manage'), true);
  assert.equal(can('admin', 'pos.checkout'), true);
  assert.equal(can(null, 'pos.checkout'), false);
  assert.equal(roleRank('admin'), 3);
  assert.equal(roleRank('ghost'), 0);
});

test('requireCapability enforces RBAC on the service', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const login = auth.login({ username: 'admin', password: 'Admin123' });
  const admin = auth.userForToken(login.token);
  assert.equal(auth.requireCapability(admin, 'backup.run'), true);
  assert.equal(auth.requireCapability(null, 'backup.run'), false);
});

test('user create + audit trail are recorded', () => {
  const { store, auth } = newAuth();
  const res = store.db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('cashier1', hashPassword('Abcdefg1'), 'Casey', ROLES.CASHIER);
  auth.audit(res.lastInsertRowid, 'cashier1', 'LOGIN', 'user', res.lastInsertRowid, 'test login');
  const log = auth.listAudit();
  assert.ok(log.some(a => a.username === 'cashier1' && a.action === 'LOGIN'));
});

test('listUsers returns active users with expected fields', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const users = auth.listUsers();
  assert.equal(users.length, 1);
  assert.ok(users[0].username);
  assert.ok(users[0].full_name);
  assert.ok(users[0].role);
  assert.equal(users[0].active, 1);
});

// ---------- Capability Management ----------

function createCashier(auth) {
  const res = auth.store.db.prepare(
    "INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)"
  ).run('cashier1', hashPassword('Abcdefg1'), 'Casey Cashier', ROLES.CASHIER);
  return { id: res.lastInsertRowid, username: 'cashier1' };
}

function createManager(auth) {
  const res = auth.store.db.prepare(
    "INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)"
  ).run('manager1', hashPassword('Abcdefg1'), 'Max Manager', ROLES.MANAGER);
  return { id: res.lastInsertRowid, username: 'manager1' };
}

test('grantCapability adds a capability to a cashier', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const admin = auth.store.db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  const cashier = createCashier(auth);

  const result = auth.grantCapability(admin.id, cashier.id, 'inventory.adjust');
  assert.equal(result.ok, true);
  assert.equal(result.capability, 'inventory.adjust');

  const caps = auth.listUserCapabilities(cashier.id);
  const grant = caps.find(c => c.capability === 'inventory.adjust');
  assert.ok(grant);
  assert.equal(grant.source, 'grant');
});

test('grantCapability fails if granter lacks the capability', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const admin = auth.store.db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  const cashier = createCashier(auth);
  const manager = createManager(auth);

  // Manager cannot grant users.manage (requires admin)
  const result = auth.grantCapability(manager.id, cashier.id, 'users.manage');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'GRANTER_LACKS_CAPABILITY');
});

test('grantCapability fails for unknown capability', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const admin = auth.store.db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  const cashier = createCashier(auth);

  const result = auth.grantCapability(admin.id, cashier.id, 'nonexistent.cap');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'UNKNOWN_CAPABILITY');
});

test('grantCapability fails for non-existent user', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const admin = auth.store.db.prepare('SELECT * FROM users WHERE username = ?').get('admin');

  const result = auth.grantCapability(admin.id, 99999, 'inventory.adjust');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'USER_NOT_FOUND');
});

test('grantCapability fails if user already has it via role', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const admin = auth.store.db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  const cashier = createCashier(auth);

  // Cashier already has pos.checkout via role (rank 1 >= 1)
  const result = auth.grantCapability(admin.id, cashier.id, 'pos.checkout');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ALREADY_HAS_ROLE_CAPABILITY');
});

test('grantCapability fails on duplicate grant', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const admin = auth.store.db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  const cashier = createCashier(auth);

  auth.grantCapability(admin.id, cashier.id, 'inventory.adjust');
  const result = auth.grantCapability(admin.id, cashier.id, 'inventory.adjust');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ALREADY_GRANTED');
});

test('revokeCapability removes a granted capability', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const admin = auth.store.db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  const cashier = createCashier(auth);

  auth.grantCapability(admin.id, cashier.id, 'inventory.adjust');
  const result = auth.revokeCapability(admin.id, cashier.id, 'inventory.adjust');
  assert.equal(result.ok, true);

  const caps = auth.listUserCapabilities(cashier.id);
  const grant = caps.find(c => c.capability === 'inventory.adjust');
  assert.ok(!grant);
});

test('revokeCapability fails for capability that was not granted', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const admin = auth.store.db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  const cashier = createCashier(auth);

  const result = auth.revokeCapability(admin.id, cashier.id, 'inventory.adjust');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'NOT_GRANTED');
});

test('requireCapability checks user-level grants', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const admin = auth.store.db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  const cashier = createCashier(auth);

  // Cashier does NOT have inventory.adjust by role
  assert.equal(auth.requireCapability(cashier, 'inventory.adjust'), false);

  // Grant it
  auth.grantCapability(admin.id, cashier.id, 'inventory.adjust');

  // Now cashier has it via grant
  assert.equal(auth.requireCapability(cashier, 'inventory.adjust'), true);
});

test('revokeCapability restores role-based restriction', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const admin = auth.store.db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  const cashier = createCashier(auth);

  auth.grantCapability(admin.id, cashier.id, 'inventory.adjust');
  assert.equal(auth.requireCapability(cashier, 'inventory.adjust'), true);

  auth.revokeCapability(admin.id, cashier.id, 'inventory.adjust');
  assert.equal(auth.requireCapability(cashier, 'inventory.adjust'), false);
});

test('listUserCapabilities shows role-based and granted capabilities', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const admin = auth.store.db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  const cashier = createCashier(auth);

  auth.grantCapability(admin.id, cashier.id, 'inventory.adjust');
  const caps = auth.listUserCapabilities(cashier.id);

  const roleCaps = caps.filter(c => c.source === 'role');
  const grantCaps = caps.filter(c => c.source === 'grant');

  assert.ok(roleCaps.some(c => c.capability === 'pos.checkout'));
  assert.ok(!roleCaps.some(c => c.capability === 'inventory.adjust'));
  assert.ok(grantCaps.some(c => c.capability === 'inventory.adjust'));
  assert.equal(grantCaps.length, 1);
});

test('revokeCapability on role-based capability does nothing (not a grant)', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const admin = auth.store.db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  const cashier = createCashier(auth);

  // pos.checkout is role-based, not a grant — revoke returns NOT_GRANTED
  const result = auth.revokeCapability(admin.id, cashier.id, 'pos.checkout');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'NOT_GRANTED');
});

test('grantCapability audit trail is recorded', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const admin = auth.store.db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  const cashier = createCashier(auth);

  auth.grantCapability(admin.id, cashier.id, 'inventory.adjust');
  const log = auth.listAudit();
  assert.ok(log.some(a => a.action === 'CAPABILITY_GRANT' && a.entity_id === cashier.id));
});

test('revokeCapability audit trail is recorded', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const admin = auth.store.db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  const cashier = createCashier(auth);

  auth.grantCapability(admin.id, cashier.id, 'inventory.adjust');
  auth.revokeCapability(admin.id, cashier.id, 'inventory.adjust');
  const log = auth.listAudit();
  assert.ok(log.some(a => a.action === 'CAPABILITY_REVOKE' && a.entity_id === cashier.id));
});

test('publicUser includes capabilities on login', () => {
  const { auth } = newAuth();
  auth.ensureDefaultAdmin();
  const admin = auth.store.db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  const cashier = createCashier(auth);

  auth.grantCapability(admin.id, cashier.id, 'inventory.adjust');
  const login = auth.login({ username: 'cashier1', password: 'Abcdefg1' });
  assert.equal(login.ok, true);
  assert.ok(Array.isArray(login.user.capabilities));
  assert.ok(login.user.capabilities.some(c => c.capability === 'inventory.adjust' && c.source === 'grant'));
  assert.ok(login.user.capabilities.some(c => c.capability === 'pos.checkout' && c.source === 'role'));
});

test('exported CAP_RANK contains all expected capabilities', () => {
  assert.ok(CAP_RANK['pos.checkout'] !== undefined);
  assert.ok(CAP_RANK['users.manage'] !== undefined);
  assert.ok(CAP_RANK['inventory.adjust'] !== undefined);
  assert.ok(CAP_RANK['audit.view'] !== undefined);
});
