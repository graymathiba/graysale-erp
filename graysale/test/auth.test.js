import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';
import { hashPassword, verifyPassword } from '../src/services/auth.js';

test('password hashing round-trips and rejects wrong values', () => {
  const h = hashPassword('secret-123');
  assert.ok(verifyPassword('secret-123', h));
  assert.ok(!verifyPassword('nope', h));
  assert.ok(!verifyPassword('secret-123', 'not-a-hash'));
});

test('default admin can log in and has all capabilities', () => {
  const app = makeApp();
  const r = app.auth.login({ username: 'admin', password: 'admin123' });
  assert.equal(r.ok, true);
  assert.equal(r.user.role, 'owner');
  assert.equal(app.auth.hasPermission(r.user, 'catalog.manage'), true);
  assert.equal(app.auth.hasPermission(r.user, 'pos.sell'), true);
});

test('wrong credentials are rejected', () => {
  const app = makeApp();
  assert.deepEqual(app.auth.login({ username: 'admin', password: 'wrong' }), {
    ok: false,
    error: 'INVALID_CREDENTIALS',
  });
});

test('userForToken resolves logged-in sessions and expires cleanly', () => {
  const app = makeApp();
  const r = app.auth.login({ username: 'admin', password: 'admin123' });
  assert.equal(app.auth.userForToken(r.token).username, 'admin');
  app.auth.logout(r.token);
  assert.equal(app.auth.userForToken(r.token), null);
});

test('roles grant the documented capability matrix', () => {
  const app = makeApp();
  const sheriff = app.auth.createUser({ username: 'cashier1', password: 'pw', fullName: 'Cashier', role: 'cashier' });
  const user = app.auth.listUsers().find((u) => u.id === sheriff);
  assert.equal(app.auth.hasPermission({ ...user, role: 'cashier' }, 'pos.sell'), true);
  assert.equal(app.auth.hasPermission({ ...user, role: 'cashier' }, 'catalog.manage'), false);
  assert.equal(app.auth.hasPermission({ ...user, role: 'cashier' }, 'accounting.view'), false);
  assert.equal(app.auth.hasPermission({ ...user, role: 'accountant' }, 'accounting.post'), true);
  assert.equal(app.auth.hasPermission({ ...user, role: 'manager' }, 'purchasing.manage'), true);
});

test('require() enforces authentication and authorization', () => {
  const app = makeApp();
  const admin = app.auth.login({ username: 'admin', password: 'admin123' }).user;
  assert.throws(() => app.auth.require(null, 'pos.sell'), { status: 401 });
  assert.throws(() => app.auth.require({ ...admin, role: 'cashier' }, 'catalog.manage'), { status: 403 });
  assert.equal(app.auth.require(admin, 'catalog.manage').id, admin.id);
});

test('cannot create a user with an unknown role or duplicate username', () => {
  const app = makeApp();
  assert.throws(() => app.auth.createUser({ username: 'admin', password: 'pw', role: 'owner' }), /DUPLICATE_USERNAME/);
  assert.throws(() => app.auth.createUser({ username: 'y', password: 'pw', role: 'god' }), /INVALID_ROLE/);
});
