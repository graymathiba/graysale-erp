import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, admin } from './helpers.js';
import { LicensingService } from '../src/licensing/index.js';

// Tenant-owner self-service profile updates + Control Tower overrides.
// All writes are scoped `WHERE id = <tenantId>` in TenantProfileService; a
// password change always requires the current password (self-service) and
// both flows invalidate existing owner sessions.

test('owner updates company profile, business info and login details', () => {
  const app = makeApp();
  const actor = admin(app);
  const T = actor.tenantId;

  const saved = app.tenantProfile.update(
    {
      company_name: 'Beam Investments (Pvt) Ltd',
      trading_as: 'Beam1 Supermarket',
      address: '10 Samora Machel Ave, Harare',
      telephone: '+263 242 700 000',
      owner_username: 'beam1',
      owner_email: 'beam1@example.com',
    },
    T,
    actor,
  );

  assert.equal(saved.company_name, 'Beam Investments (Pvt) Ltd');
  assert.equal(saved.trading_as, 'Beam1 Supermarket');
  assert.equal(saved.address, '10 Samora Machel Ave, Harare');
  assert.equal(saved.owner_username, 'beam1');
  assert.equal(saved.owner_email, 'beam1@example.com');

  // The tenant-scoped company_settings row reflects the change.
  const cs = app.companySettings.get(T);
  assert.equal(cs.company_name, 'Beam Investments (Pvt) Ltd');
  assert.equal(cs.trading_as, 'Beam1 Supermarket');
});

test('username change takes effect for login under the same tenant', () => {
  const app = makeApp();
  const actor = admin(app);
  const T = actor.tenantId;

  app.tenantProfile.update({ owner_username: 'beam1' }, T, actor);
  assert.equal(app.auth.login({ username: 'beam1', password: 'admin123' }).ok, true);
  assert.equal(app.auth.login({ username: 'admin', password: 'admin123' }).ok, false);
});

test('owner password change requires current password and invalidates old login', () => {
  const app = makeApp();
  const actor = admin(app);
  const T = actor.tenantId;

  // No current password supplied â†’ refused.
  assert.throws(() => app.tenantProfile.update({ new_password: 'newpass123' }, T, actor), /CURRENT_PASSWORD_REQUIRED/);
  // Wrong current password â†’ refused.
  assert.throws(
    () => app.tenantProfile.update({ new_password: 'newpass123', current_password: 'wrong' }, T, actor),
    /INVALID_CURRENT_PASSWORD/,
  );

  // Correct current password â†’ password replaced, old login rejected.
  app.tenantProfile.update({ new_password: 'newpass123', current_password: 'admin123' }, T, actor);
  assert.equal(app.auth.login({ username: 'admin', password: 'admin123' }).ok, false);
  assert.equal(app.auth.login({ username: 'admin', password: 'newpass123' }).ok, true);
});

test('self-service writes are scoped to the caller tenant and owner', () => {
  const app = makeApp();
  const actor = admin(app);
  const licensing = new LicensingService(app.db);

  // A different tenant with its OWN owner account exists; tenant A's owner
  // must not be able to touch it.
  const tenantB = licensing.tenants.create({ companyName: 'Tenant B', ownerEmail: 'b@ex.com' });
  app.auth.createUser({ username: 'bowner', password: 'pw', role: 'owner', tenantId: tenantB.id });

  const before = app.tenantProfile.get(tenantB.id);
  assert.throws(
    () => app.tenantProfile.update({ company_name: 'Hacked' }, tenantB.id, actor),
    (e) => e.code === 'FORBIDDEN' && e.message === 'OWNER_ONLY',
  );
  // A cashier from tenant A can't edit tenant A's profile either.
  const cashier = app.auth.createUser({ username: 'c1', password: 'pw', role: 'cashier', tenantId: actor.tenantId });
  assert.throws(
    () =>
      app.tenantProfile.update({ company_name: 'Nope' }, actor.tenantId, {
        id: cashier,
        username: 'c1',
        role: 'cashier',
      }),
    (e) => e.code === 'FORBIDDEN' && e.message === 'OWNER_ONLY',
  );
  // Tenant B untouched.
  assert.equal(app.tenantProfile.get(tenantB.id).company_name, before.company_name);
});

test('duplicate owner usernames are rejected (global uniqueness)', () => {
  const app = makeApp();
  const actor = admin(app);
  const T = actor.tenantId;
  app.auth.createUser({ username: 'cashier1', password: 'pw', role: 'cashier', tenantId: T });

  assert.throws(() => app.tenantProfile.update({ owner_username: 'cashier1' }, T, actor), /DUPLICATE_USERNAME/);
});

test('super-admin override edits tenant + owner and force-resets the password', () => {
  const app = makeApp();
  const actor = admin(app);
  const licensing = new LicensingService(app.db);

  const tenantB = licensing.tenants.create({
    companyName: 'Tenant B',
    ownerEmail: 'b@ex.com',
    ownerUsername: 'bowner',
    password: 'oldpass',
  });

  const updated = app.tenantProfile.adminUpdate(
    tenantB.id,
    {
      company_name: 'Tenant B (Rebranded)',
      owner_email: 'boss@example.com',
      owner_username: 'boss',
      new_password: 'forcedpw',
      address: 'Unit 4, Willowvale',
    },
    actor,
  );

  assert.equal(updated.company_name, 'Tenant B (Rebranded)');
  assert.equal(updated.owner_email, 'boss@example.com');
  assert.equal(updated.owner_username, 'boss');
  assert.equal(updated.address, 'Unit 4, Willowvale');

  // Tenant B owner can no longer use the old password.
  assert.equal(app.auth.login({ username: 'bowner', password: 'oldpass' }).ok, false);
  const relogin = app.auth.login({ username: 'boss', password: 'forcedpw' });
  assert.equal(relogin.ok, true);
  assert.equal(relogin.user.tenantId, tenantB.id);

  // Unknown tenant â†’ service returns null (route turns it into 404).
  assert.equal(app.tenantProfile.adminUpdate('no-such-id', { company_name: 'X' }, actor), null);
});
