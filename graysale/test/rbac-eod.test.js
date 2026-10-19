import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, seedCatalog, customer, admin, assertBalanced } from './helpers.js';

// ---------- User management / RBAC ----------
test('users can be deactivated (soft-delete) and reactivated', () => {
  const app = makeApp();
  const owner = admin(app);
  const id = app.auth.createUser({ username: 'clerk', password: 'pw', fullName: 'Clerk', role: 'cashier' });

  const deactivated = app.auth.deactivateUser(id, owner);
  assert.equal(deactivated.active, 0);
  assert.equal(app.auth.login({ username: 'clerk', password: 'pw' }).ok, false, 'inactive user cannot log in');

  const reactivated = app.auth.reactivateUser(id, owner);
  assert.equal(reactivated.active, 1);
  assert.equal(app.auth.login({ username: 'clerk', password: 'pw' }).ok, true);
});

test('a user with an OPEN shift containing transactions cannot be deleted', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  const owner = admin(app);
  const id = app.auth.createUser({ username: 'cashier1', password: 'pw', role: 'cashier' });
  const cashier = app.auth.listUsers().find((u) => u.id === id);

  const sh = app.eod.open({ user: cashier, openingCashCents: 0 });
  app.pos.checkout({
    items: [{ productId: A.id, qty: 1 }],
    payments: [{ method: 'CASH', amount: 6000 }],
    user: cashier,
  });

  assert.ok(app.auth.openShiftInUse(id), 'open shift with transactions should be flagged');
  assert.throws(() => app.auth.deleteUser(id, owner), /USER_HAS_OPEN_SHIFT/);

  // Closing the shift frees the user for deletion.
  app.eod.zReport(sh.id, { user: cashier });
  app.auth.deleteUser(id, owner);
  assert.equal(
    app.auth.listUsers().find((u) => u.id === id),
    undefined,
  );
});

test('cannot delete yourself or another owner', () => {
  const app = makeApp();
  const owner = admin(app);
  assert.throws(() => app.auth.deleteUser(owner.id, owner), /CANNOT_DELETE_SELF/);
  const otherOwner = app.auth.createUser({ username: 'bob', password: 'pw', role: 'owner' });
  assert.throws(() => app.auth.deleteUser(otherOwner, owner), /CANNOT_DELETE_OWNER/);
});

test('cashier is blocked from user management and accounting; granted POS + EOD self-report', () => {
  const app = makeApp();
  const id = app.auth.createUser({ username: 'cashier2', password: 'pw', role: 'cashier' });
  const cashier = app.auth.listUsers().find((u) => u.id === id);
  assert.equal(app.auth.hasPermission(cashier, 'pos.sell'), true);
  assert.equal(app.auth.hasPermission(cashier, 'eod.self'), true);
  assert.equal(app.auth.hasPermission(cashier, 'accounting.view'), false);
  assert.equal(app.auth.hasPermission(cashier, 'users.view'), false);
  assert.equal(app.auth.hasPermission(cashier, 'users.delete'), false);
  assert.equal(app.auth.hasPermission(cashier, 'accounting.post'), false);
  // manager is an admin for user management/deletion
  const mgrId = app.auth.createUser({ username: 'mgr', password: 'pw', role: 'manager' });
  const mgr = app.auth.listUsers().find((u) => u.id === mgrId);
  assert.equal(app.auth.hasPermission(mgr, 'users.delete'), true);
});

// ---------- EOD X-report / Z-report ----------
test('EOD report breaks down payment methods, layby, and cash discrepancy per cashier', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  const user = admin(app);

  const sh = app.eod.open({ user, openingCashCents: 5000 });

  // one cash sale (5175 total, tendered 6000 -> change 825)
  app.pos.checkout({ items: [{ productId: A.id, qty: 1 }], payments: [{ method: 'CASH', amount: 6000 }], user });
  // one card sale
  app.pos.checkout({ items: [{ productId: A.id, qty: 2 }], payments: [{ method: 'CARD', amount: 10350 }], user });
  // one layby with deposit
  const cid = customer(app, 'Layby Customer');
  app.pos.createLayaway({ customerId: cid, items: [{ productId: A.id, qty: 1 }], deposit: 1000, user });

  // X-report is read-only and leaves the shift OPEN
  const x = app.eod.report(sh.id);
  assert.equal(x.shift.status, 'OPEN');
  assert.equal(x.opening_float_cents, 5000);
  assert.equal(x.breakdown.cash, 5175);
  assert.equal(x.breakdown.card, 10350);
  assert.equal(x.layby.collected_cents, 1000);
  assert.equal(x.sale_count, 2);
  // expected cash = opening 5000 + cash sales 5175 + layby deposits 1000 = 11175
  assert.equal(x.expected_cash_cents, 11175);
  assert.equal(x.counted_cash_cents, null);
  assert.equal(x.variance_cents, null);

  // Z-report auto-closes and records counted cash -> variance
  const z = app.eod.zReport(sh.id, { countedCashCents: 11300, user });
  assert.equal(z.shift.status, 'CLOSED');
  assert.equal(z.counted_cash_cents, 11300);
  assert.equal(z.variance_cents, 125);

  // shift is now closed; cannot Z-close again
  assert.throws(() => app.eod.zReport(sh.id, { user }), /SHIFT_NOT_OPEN/);
  assertBalanced(app);
});

// ---------- Customer layaway tracking ----------
test('customer layaways lists outstanding balances for debt management', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  const user = admin(app);
  const cid = customer(app, 'Debt Customer');

  const la = app.pos.createLayaway({ customerId: cid, items: [{ productId: A.id, qty: 1 }], deposit: 1000, user });
  // partial balance payment (deposit + 2000 more)
  la.id && app.pos.addLayawayPayment(la.id, [{ method: 'CASH', amount: 2000 }], user);

  const rows = app.customers.layaways(cid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total_cents, 5175);
  assert.equal(rows[0].paid_cents, 3000);
  assert.equal(rows[0].balance_cents, 2175);
});
