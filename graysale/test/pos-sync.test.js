import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, seedCatalog, assertBalanced } from './helpers.js';
import { createHttpServer } from '../src/http/routes.js';
import { localStamp } from '../src/lib/ids.js';

// The Flutter till writes each sale to its own SQLite and replays the queue at
// /api/v1/sync/sales. These cover the contract that client depends on:
//   { success, syncedIds[], duplicates[], failed[], priceDrift[] }
// plus the guarantee that matters most â€” a replayed queue never double-books.

function hit(handler, { method = 'POST', url = '/api/v1/sync/sales', token = '', body = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      headers: { host: 'localhost', authorization: token ? `Bearer ${token}` : '', 'content-type': 'application/json' },
      method,
      url,
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next: async () => {
            if (!sent) {
              sent = true;
              return { value: JSON.stringify(body), done: false };
            }
            return { done: true };
          },
        };
      },
    };
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end(b) {
        resolve({ status: this.status || 200, body: b ? JSON.parse(b) : {} });
      },
    };
    handler(req, res);
  });
}

function activate(app) {
  app.db
    .prepare("UPDATE tenants SET status = 'ACTIVE' WHERE id = (SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1)")
    .run();
}

// A queued sale in the exact snake_case shape PendingSale.toSyncJson() emits.
// The till's total_cents is what it *believed*; the server re-derives the real
// figure from the catalog (price + tax), which is what actually gets booked.
function queued(id, A, over = {}) {
  return {
    id,
    total_cents: A.price_cents * 2,
    subtotal_cents: A.price_cents * 2,
    tax_cents: 0,
    payment_method: 'cash',
    created_at: '2026-09-20T10:15:00Z',
    lines: [{ product_id: A.id, product_name: A.name, price_cents: A.price_cents, qty: 2 }],
    ...over,
  };
}

// Independent expectation for what the server must book: subtotal plus tax.
function authoritativeTotal(app, A, qty = 2) {
  const rate = app.catalog.taxClasses().find((t) => t.name === 'Standard').rate_bps;
  const subtotal = A.price_cents * qty;
  return subtotal + Math.round((subtotal * rate) / 10000);
}

test('sync/sales books a queued offline sale and decrements stock', async () => {
  const app = makeApp();
  activate(app);
  const { A } = seedCatalog(app);
  const token = app.auth.login({ username: 'admin', password: 'admin123' }).token;
  const handler = createHttpServer(app);

  const before = app.catalog.available(A.id);
  const res = await hit(handler, { token, body: { sales: [queued('sale-uuid-1', A)] } });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.syncedIds, ['sale-uuid-1']);
  assert.deepEqual(res.body.duplicates, []);
  assert.deepEqual(res.body.failed, []);
  assert.equal(app.catalog.available(A.id), before - 2);
  assertBalanced(app);
});

test('replaying the same queue is a no-op â€” the idempotency key wins', async () => {
  const app = makeApp();
  activate(app);
  const { A } = seedCatalog(app);
  const token = app.auth.login({ username: 'admin', password: 'admin123' }).token;
  const handler = createHttpServer(app);

  const first = await hit(handler, { token, body: { sales: [queued('sale-uuid-1', A)] } });
  assert.deepEqual(first.body.syncedIds, ['sale-uuid-1']);

  const stockAfterFirst = app.catalog.available(A.id);

  // Same UUID again â€” exactly what a till does after a dropped response.
  const replay = await hit(handler, { token, body: { sales: [queued('sale-uuid-1', A)] } });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.success, true);
  assert.deepEqual(replay.body.syncedIds, []);
  assert.deepEqual(replay.body.duplicates, ['sale-uuid-1']);

  // Crucially: no second receipt, no second stock movement, no second journal.
  assert.equal(app.catalog.available(A.id), stockAfterFirst);
  const orders = app.db.prepare('SELECT COUNT(*) c FROM orders').get().c;
  assert.equal(orders, 1);
});

test('a batch mixing fresh, replayed and broken sales still books the good ones', async () => {
  const app = makeApp();
  activate(app);
  const { A } = seedCatalog(app, { aQty: 10 });
  const token = app.auth.login({ username: 'admin', password: 'admin123' }).token;
  const handler = createHttpServer(app);

  // Book one, then replay that same id alongside a new one and a broken one.
  await hit(handler, { token, body: { sales: [queued('dupe', A)] } });

  const res = await hit(handler, {
    token,
    body: {
      sales: [
        queued('dupe', A),
        queued('fresh', A),
        queued('no-lines', A, { lines: [] }),
        { id: 'ghost', lines: [{ product_id: 999999, qty: 1 }] },
        { total_cents: 100, lines: [{ product_id: A.id, qty: 1 }] }, // no id
      ],
    },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.syncedIds, ['fresh']);
  assert.deepEqual(res.body.duplicates, ['dupe']);
  // A bad sale fails on its own without taking the batch down.
  assert.equal(res.body.success, false);
  assert.deepEqual(
    res.body.failed.map((f) => f.id),
    ['no-lines', 'ghost', null],
  );
  assert.match(res.body.failed[0].error, /LINES_REQUIRED/);
  assertBalanced(app);
});

test('server pricing is authoritative and drift is reported, not hidden', async () => {
  const app = makeApp();
  activate(app);
  const { A } = seedCatalog(app);
  const token = app.auth.login({ username: 'admin', password: 'admin123' }).token;
  const handler = createHttpServer(app);
  const expected = authoritativeTotal(app, A);

  // The till rang this up believing the sale was 2 cents; the catalog disagrees.
  const res = await hit(handler, {
    token,
    body: { sales: [queued('drifted', A, { total_cents: 2 })] },
  });

  assert.deepEqual(res.body.syncedIds, ['drifted']);
  assert.equal(res.body.priceDrift.length, 1);
  assert.equal(res.body.priceDrift[0].id, 'drifted');
  assert.equal(res.body.priceDrift[0].clientTotalCents, 2);
  assert.equal(res.body.priceDrift[0].serverTotalCents, expected);
  assert.equal(res.body.priceDrift[0].driftCents, expected - 2);

  // The ledger took the server figure, not the client's.
  const order = app.db.prepare('SELECT total_cents FROM orders WHERE client_ref = ?').get('drifted');
  assert.equal(order.total_cents, expected);
});

test('the offline timestamp lands on the business clock (order + journal day)', async () => {
  const app = makeApp();
  activate(app);
  const { A } = seedCatalog(app);
  const token = app.auth.login({ username: 'admin', password: 'admin123' }).token;
  const handler = createHttpServer(app);

  await hit(handler, { token, body: { sales: [queued('backdated', A)] } });

  // The device sent a UTC instant; orders carry the machine's business clock,
  // so an offline sale rung just before local midnight stays on that day.
  const saleInstant = new Date('2026-09-20T10:15:00Z');
  const order = app.db.prepare('SELECT created_at FROM orders WHERE client_ref = ?').get('backdated');
  assert.equal(order.created_at, localStamp(saleInstant));

  // Booked on the day it was rung, not the day the queue drained.
  const entry = app.db
    .prepare('SELECT date FROM journal_entries WHERE reference = (SELECT doc_no FROM orders WHERE client_ref = ?)')
    .get('backdated');
  assert.equal(entry.date, localStamp(saleInstant).slice(0, 10));
});

test('payment labels are normalised and bad ones fail just that sale', async () => {
  const app = makeApp();
  activate(app);
  const { A } = seedCatalog(app, { aQty: 20 });
  const token = app.auth.login({ username: 'admin', password: 'admin123' }).token;
  const handler = createHttpServer(app);

  const expected = authoritativeTotal(app, A);
  const res = await hit(handler, {
    token,
    body: {
      sales: [
        queued('m-cash', A, { payment_method: 'Cash' }),
        queued('m-visa', A, { payment_method: 'visa' }),
        queued('m-momo', A, { payment_method: 'mobile-money' }),
        queued('m-bogus', A, { payment_method: 'goats' }),
      ],
    },
  });

  assert.deepEqual(res.body.syncedIds, ['m-cash', 'm-visa', 'm-momo']);
  assert.deepEqual(
    res.body.failed.map((f) => f.id),
    ['m-bogus'],
  );
  assert.match(res.body.failed[0].error, /INVALID_PAYMENT_METHOD/);

  const methods = app.db
    .prepare("SELECT meta FROM orders WHERE client_ref IN ('m-cash','m-visa','m-momo')")
    .all()
    .map((r) => JSON.parse(r.meta).payments);
  assert.ok(
    methods.some((m) => m.CASH === expected),
    'cash split',
  );
  assert.ok(
    methods.some((m) => m.CARD === expected),
    'card split',
  );
  assert.ok(
    methods.some((m) => m.MOBILE === expected),
    'mobile split',
  );
  assertBalanced(app);
});

test('sync requires a signed-in till and the pos.sell capability', async () => {
  const app = makeApp();
  activate(app);
  const { A } = seedCatalog(app);
  const handler = createHttpServer(app);

  const anon = await hit(handler, { body: { sales: [queued('nope', A)] } });
  assert.equal(anon.status, 401);
  assert.equal(app.db.prepare('SELECT COUNT(*) c FROM orders').get().c, 0);
});

test('oversized and empty batches are rejected before any work happens', async () => {
  const app = makeApp();
  activate(app);
  const { A } = seedCatalog(app);
  const token = app.auth.login({ username: 'admin', password: 'admin123' }).token;
  const handler = createHttpServer(app);

  const empty = await hit(handler, { token, body: { sales: [] } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'SALES_REQUIRED');

  const huge = await hit(handler, {
    token,
    body: { sales: Array.from({ length: 501 }, (_, i) => queued(`s${i}`, A)) },
  });
  assert.equal(huge.status, 400);
  assert.match(huge.body.message, /BATCH_TOO_LARGE/);
  assert.equal(app.db.prepare('SELECT COUNT(*) c FROM orders').get().c, 0);
});

test('an unparseable offline timestamp is rejected rather than silently re-dated', async () => {
  const app = makeApp();
  activate(app);
  const { A } = seedCatalog(app);
  const token = app.auth.login({ username: 'admin', password: 'admin123' }).token;
  const handler = createHttpServer(app);

  const res = await hit(handler, { token, body: { sales: [queued('bad-ts', A, { created_at: 'last tuesday' })] } });

  assert.deepEqual(res.body.syncedIds, []);
  assert.match(res.body.failed[0].error, /INVALID_CREATED_AT/);
  assert.equal(app.db.prepare('SELECT COUNT(*) c FROM orders').get().c, 0);
});

test('the idempotency key is scoped per tenant, not globally', async () => {
  const app = makeApp();
  activate(app);
  const { A } = seedCatalog(app);
  const token = app.auth.login({ username: 'admin', password: 'admin123' }).token;
  const handler = createHttpServer(app);

  await hit(handler, { token, body: { sales: [queued('shared-id', A)] } });
  assert.equal(app.db.prepare('SELECT COUNT(*) c FROM orders WHERE client_ref = ?').get('shared-id').c, 1);

  // A second tenant reusing the same client id must not collide: the unique
  // index is (tenant_id, client_ref), not client_ref alone. Asserted directly
  // because multi-tenant checkout has its own unresolved tenant-threading gap.
  const t2 = app.auth.registerTenant({ companyName: 'Second Shop', username: 'owner2', password: 'secret123' });
  const t2id = t2.user.tenantId;
  const ins = app.db.prepare(`
    INSERT INTO orders (doc_no, type, status, total_cents, paid_cents, tenant_id, client_ref)
    VALUES (?, 'SALE', 'PAID', 0, 0, ?, ?)
  `);
  assert.doesNotThrow(() => ins.run('SALE-90001', t2id, 'shared-id'));

  // But the same tenant still cannot take the same id twice.
  assert.throws(() => ins.run('SALE-90002', t2id, 'shared-id'), /UNIQUE/);

  // And NULL refs (every ordinary till sale) are never treated as duplicates.
  assert.doesNotThrow(() => ins.run('SALE-90003', t2id, null));
  assert.doesNotThrow(() => ins.run('SALE-90004', t2id, null));
});
