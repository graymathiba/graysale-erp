import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';
import { LicensingService } from '../src/licensing/index.js';
import { verifyPassword } from '../src/services/auth.js';

test('self-registration creates a PENDING_ACTIVATION tenant with a working owner login', () => {
  const app = makeApp();
  const r = app.auth.registerTenant({
    companyName: 'Beamlink Tech',
    username: 'owner',
    email: 'owner@beamlink.com',
    password: 'secret123',
  });
  assert.equal(r.ok, true);
  assert.equal(r.tenant.status, 'PENDING_ACTIVATION');
  assert.equal(r.tenant.needsActivation, true);
  assert.equal(r.tenant.license_key, null);
  assert.equal(r.user.username, 'owner');

  const login = app.auth.login({ username: 'owner', password: 'secret123' });
  assert.equal(login.ok, true);
  assert.equal(login.requiresPasswordChange, false);
  assert.equal(login.tenant.needsActivation, true);
});

test('Control Tower onboarding without a password issues a temp password the owner must change', () => {
  const app = makeApp();
  const licensing = new LicensingService(app.db);
  const t = licensing.tenants.create({ companyName: 'Acme Stores', ownerEmail: 'boss@acme.com' });
  assert.ok(t.tempPassword, 'temporary password present for the admin to relay');
  assert.equal(t.owner_username, 'boss');

  const login = app.auth.login({ username: 'boss', password: t.tempPassword });
  assert.equal(login.ok, true);
  assert.equal(login.requiresPasswordChange, true);

  const row0 = app.db.prepare('SELECT requires_password_change FROM users WHERE username = ?').get('boss');
  assert.equal(row0.requires_password_change, 1);

  app.auth.setPassword(login.user.id, 'my-own-pass1');

  const row = app.db
    .prepare('SELECT password_hash, requires_password_change FROM users WHERE username = ?')
    .get('boss');
  assert.equal(row.requires_password_change, 0, 'flag cleared after set-password');
  assert.equal(verifyPassword('my-own-pass1', row.password_hash), true);
  assert.equal(verifyPassword(t.tempPassword, row.password_hash), false);
});

test('Control Tower onboarding with a custom password does not force a change', () => {
  const app = makeApp();
  const licensing = new LicensingService(app.db);
  const t = licensing.tenants.create({
    companyName: 'Widget Co',
    ownerEmail: 'head@widget.com',
    ownerUsername: 'head',
    password: 'chooseyour1',
  });
  assert.equal(t.tempPassword, undefined);
  const login = app.auth.login({ username: 'head', password: 'chooseyour1' });
  assert.equal(login.ok, true);
  assert.equal(login.requiresPasswordChange, false);
});

test('Control Tower password reset forces the owner to set a new password', () => {
  const app = makeApp();
  const licensing = new LicensingService(app.db);
  const t = licensing.tenants.create({
    companyName: 'Widget Co',
    ownerEmail: 'head@widget.com',
    password: 'original1',
  });
  const before = app.auth.login({ username: 'head', password: 'original1' });
  assert.equal(before.requiresPasswordChange, false);

  licensing.tenants.update(t.id, { new_password: 'adminreset1' });

  const again = app.auth.login({ username: 'head', password: 'adminreset1' });
  assert.equal(again.ok, true);
  assert.equal(again.requiresPasswordChange, true, 'admin reset forces the owner to set their own password');
});

test('duplicate owner usernames are rejected at onboarding', () => {
  const app = makeApp();
  const licensing = new LicensingService(app.db);
  licensing.tenants.create({ companyName: 'A Co', ownerEmail: 'a@x.com', ownerUsername: 'bob', password: 'pass1x' });
  assert.throws(
    () =>
      licensing.tenants.create({
        companyName: 'B Co',
        ownerEmail: 'b@x.com',
        ownerUsername: 'bob',
        password: 'pass1x',
      }),
    /DUPLICATE_USERNAME/,
  );
});

test('default admin is provisioned as a super-admin so the Control Tower is reachable out of the box', () => {
  const app = makeApp();
  const login = app.auth.login({ username: 'admin', password: 'admin123' });
  assert.equal(login.ok, true);
  assert.equal(login.user.isSuperAdmin, true, 'default admin carries the global super-admin flag');
  assert.equal(app.auth.isSuperAdmin(login.user), true);

  // Idempotent upgrade path: an install that already has the bootstrapped
  // account as plain owner gets promoted on the next boot.
  app.db.prepare('UPDATE users SET is_super_admin = 0 WHERE username = ?').run('admin');
  app.auth.ensureDefaultData();
  const row = app.db.prepare('SELECT is_super_admin FROM users WHERE username = ?').get('admin');
  assert.equal(row.is_super_admin, 1, 'existing default admin is promoted to super-admin');
});
