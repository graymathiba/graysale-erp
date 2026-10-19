import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, seedCatalog, admin, assertBalanced } from './helpers.js';
import { createHttpServer } from '../src/http/routes.js';
import { verifyEcoCashCallback } from '../src/services/ecocash.js';
import { createHmac } from 'node:crypto';

// Minimal HTTP harness (same shape as storage.test.js) so the webhook route â€”
// signature verification + idempotent settlement â€” is exercised end-to-end.
function hit(handler, { method = 'GET', url = '/api/v1/dashboard', token = '', bodyText = '', headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      headers: {
        host: 'localhost',
        authorization: token ? `Bearer ${token}` : '',
        'content-type': 'application/json',
        ...headers,
      },
      method,
      url,
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next: async () => {
            if (!sent && bodyText) {
              sent = true;
              return { value: bodyText, done: false };
            }
            return { done: true };
          },
        };
      },
    };
    const res = {
      writeHead(status, hs) {
        this.status = status;
        this.headers = hs;
      },
      end(body) {
        resolve({ status: this.status || 200, body: body ? JSON.parse(body) : {} });
      },
    };
    handler(req, res);
  });
}

// Test tenants start PENDING_ACTIVATION (license gate); flip to ACTIVE so the
// HTTP data + webhook routes are reachable, as an activated shop would be.
function activate(app) {
  app.db
    .prepare("UPDATE tenants SET status = 'ACTIVE' WHERE id = (SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1)")
    .run();
}

function enableEcoCash(app) {
  const ups = app.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  ups.run('ecocash.enabled', '1');
  ups.run('ecocash.mode', 'simulator');
}

test('initiate holds a sale as AWAITING_PAYMENT: stock reserved, journal silent, reference issued', async () => {
  const app = makeApp();
  const { A, B } = seedCatalog(app);
  enableEcoCash(app);
  const user = admin(app);

  const res = await app.pos.ecocashInitiate({
    items: [
      { productId: A.id, qty: 2 },
      { productId: B.id, qty: 3 },
    ],
    payments: [{ method: 'ECOCASH', amount: 15180 }],
    phone: '0771234567',
    user,
  });

  assert.equal(res.status, 'AWAITING_PAYMENT');
  assert.equal(res.total_cents, 15180);
  assert.equal(res.ecocash_status, 'PENDING');
  assert.match(res.eco.reference, /^ECOCASH-/);
  assert.ok(res.eco.providerRef);

  const txn = app.eco.byReference(res.eco.reference);
  assert.equal(txn.status, 'PENDING');
  assert.equal(txn.amount_cents, 15180);
  assert.equal(txn.phone, '0771234567');

  // Nothing journaled or moved yet â€” goods only reserved.
  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM journal_entries').get().c, 0);
  assert.equal(app.catalog.qtyOnHand(A.id).qty_on_hand, 10);
  assert.equal(app.catalog.qtyOnHand(A.id).qty_reserved, 2);
  assert.equal(app.catalog.qtyOnHand(B.id).qty_reserved, 3);
  assert.equal(app.catalog.available(A.id), 8);
});

test('webhook settlement finalizes the EcoCash sale and replays are idempotent', async () => {
  const app = makeApp();
  const { A, B } = seedCatalog(app);
  enableEcoCash(app);
  activate(app);
  const handler = createHttpServer(app);
  const user = admin(app);

  const res = await app.pos.ecocashInitiate({
    items: [
      { productId: A.id, qty: 2 },
      { productId: B.id, qty: 3 },
    ],
    payments: [{ method: 'ECOCASH', amount: 15180 }],
    phone: '0771234567',
    user,
  });

  // No secret configured (simulator): callback is trusted.
  const cb = await hit(handler, {
    method: 'POST',
    url: '/api/v1/ecocash/webhook',
    bodyText: JSON.stringify({ status: 'COMPLETED', reference: res.eco.reference, amount: 151.8 }),
  });
  assert.equal(cb.status, 200, JSON.stringify(cb.body));
  assert.equal(cb.body.ok, true);
  assert.equal(cb.body.txn.status, 'COMPLETED');
  assert.equal(cb.body.order.status, 'PAID');

  const sale = app.pos.getOrder(res.id);
  assert.equal(sale.status, 'PAID');
  assert.equal(sale.paid_cents, 15180);
  assert.equal(sale.ecocash_status, 'COMPLETED');
  assert.equal(sale.ecocash_reference, res.eco.reference);
  assert.equal(app.catalog.qtyOnHand(A.id).qty_on_hand, 8);
  assert.equal(app.catalog.qtyOnHand(A.id).qty_reserved, 0);
  const entries = app.db.prepare('SELECT COUNT(*) AS c FROM journal_entries').get().c;
  assert.equal(entries, 1);
  assertBalanced(app);

  // Replay of the same callback must not double-settle.
  const replay = await hit(handler, {
    method: 'POST',
    url: '/api/v1/ecocash/webhook',
    bodyText: JSON.stringify({ status: 'COMPLETED', reference: res.eco.reference, amount: 151.8 }),
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.order.status, 'PAID');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM journal_entries').get().c, 1, 'replay must not post twice');
  assert.equal(app.catalog.qtyOnHand(A.id).qty_on_hand, 8);
});

test('callback with an amount mismatch is rejected and the sale stays pending', async () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  enableEcoCash(app);
  activate(app);
  const handler = createHttpServer(app);
  const res = await app.pos.ecocashInitiate({
    items: [{ productId: A.id, qty: 1 }],
    payments: [{ method: 'ECOCASH', amount: 5175 }],
    phone: '0771234567',
    user: admin(app),
  });
  const cb = await hit(handler, {
    method: 'POST',
    url: '/api/v1/ecocash/webhook',
    bodyText: JSON.stringify({ status: 'COMPLETED', reference: res.eco.reference, amount: 51.0 }),
  });
  assert.equal(cb.status, 400);
  assert.match(cb.body.error, /ECOCASH_AMOUNT_MISMATCH|ECO_AMOUNT_MISMATCH/);
  assert.equal(app.pos.getOrder(res.id).status, 'AWAITING_PAYMENT');
});

test('a pending EcoCash sale can be cancelled: voided and stock released', async () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  enableEcoCash(app);
  const res = await app.pos.ecocashInitiate({
    items: [{ productId: A.id, qty: 2 }],
    payments: [{ method: 'ECOCASH', amount: 10350 }],
    phone: '0771234567',
    user: admin(app),
  });
  const cancelled = app.pos.ecocashCancel(res.id, admin(app));
  assert.equal(cancelled.status, 'VOID');
  assert.equal(app.catalog.qtyOnHand(A.id).qty_reserved, 0);
  assert.equal(app.catalog.available(A.id), 10);
  assert.equal(app.eco.byOrder(res.id, 'C2B_PAYMENT').status, 'CANCELLED');
});

test('initiate failure (EcoCash disabled) voids the sale and releases stock â€” no orphaned reservation', async () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  await assert.rejects(
    app.pos.ecocashInitiate({
      items: [{ productId: A.id, qty: 1 }],
      payments: [{ method: 'ECOCASH', amount: 5175 }],
      phone: '0771234567',
      user: admin(app),
    }),
    (e) => e.message === 'ECOCASH_DISABLED',
  );
  // Stock must be fully restored â€” no AWAITING_PAYMENT order left behind.
  assert.equal(app.catalog.qtyOnHand(A.id).qty_reserved, 0);
  assert.equal(app.catalog.available(A.id), 10);
  const orphan = app.db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE status = 'AWAITING_PAYMENT'`).get();
  assert.equal(orphan.c, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM journal_entries').get().c, 0);
});

test('a FAILED callback voids the sale and releases the reservation', async () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  enableEcoCash(app);
  activate(app);
  const handler = createHttpServer(app);
  const res = await app.pos.ecocashInitiate({
    items: [{ productId: A.id, qty: 1 }],
    payments: [{ method: 'ECOCASH', amount: 5175 }],
    phone: '0771234567',
    user: admin(app),
  });
  await hit(handler, {
    method: 'POST',
    url: '/api/v1/ecocash/webhook',
    bodyText: JSON.stringify({ status: 'FAILED', reference: res.eco.reference }),
  });
  assert.equal(app.pos.getOrder(res.id).status, 'VOID');
  assert.equal(app.catalog.available(A.id), 10);
});

test('EcoCash refund pays out via two phases and restores stock, stays balanced', async () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  enableEcoCash(app);
  activate(app);
  const handler = createHttpServer(app);
  const user = admin(app);

  const sale = app.pos.checkout({
    items: [{ productId: A.id, qty: 2 }],
    payments: [{ method: 'CASH', amount: 11000 }],
    user,
  });
  assert.equal(sale.total_cents, 10350);

  const refund = await app.pos.ecocashRefund({
    saleId: sale.id,
    items: [{ productId: A.id, qty: 1 }],
    phone: '0771234567',
    reason: 'simulator test',
    user,
  });
  assert.equal(refund.status, 'AWAITING_PAYMENT');
  assert.match(refund.eco.reference, /^ECOCASH-/);

  const cb = await hit(handler, {
    method: 'POST',
    url: '/api/v1/ecocash/webhook',
    bodyText: JSON.stringify({ status: 'COMPLETED', reference: refund.eco.reference, amount: 51.75 }),
  });
  assert.equal(cb.status, 200, JSON.stringify(cb.body));
  assert.equal(cb.body.order.status, 'PAID');

  const settled = app.pos.getOrder(refund.id);
  assert.equal(settled.status, 'PAID');
  const original = app.pos.getOrder(sale.id);
  assert.equal(original.refunded_cents, 5175);
  assert.equal(app.catalog.qtyOnHand(A.id).qty_on_hand, 9, 'one unit restored');
  assertBalanced(app);
});

test('callback signatures: HMAC secret accepted, tampered body rejected', () => {
  const secret = 'verify-me';
  const body = JSON.stringify({ status: 'COMPLETED', reference: 'ECOCASH-X' });
  const good = createHmac('sha256', secret).update(body).digest('base64');
  assert.equal(verifyEcoCashCallback({ publicKey: secret, rawBody: body, signature: good }), true);
  assert.equal(verifyEcoCashCallback({ publicKey: secret, rawBody: body + 'x', signature: good }), false);
  assert.equal(verifyEcoCashCallback({ publicKey: secret, rawBody: body, signature: '' }), false);
  // Simulator trust: unsigned callbacks are accepted only in simulator mode
  // with nothing configured. Live/sandbox and absent-mode callbacks are rejected.
  assert.equal(verifyEcoCashCallback({ publicKey: '', rawBody: body, signature: '', mode: 'simulator' }), true);
  assert.equal(verifyEcoCashCallback({ publicKey: '', rawBody: body, signature: '', mode: 'live' }), false);
  assert.equal(verifyEcoCashCallback({ publicKey: '', rawBody: body, signature: '' }), false);
});

test('EcoCash callback with an unknown reference is a 404 and never settles anything', async () => {
  const app = makeApp();
  enableEcoCash(app);
  activate(app);
  const handler = createHttpServer(app);
  const cb = await hit(handler, {
    method: 'POST',
    url: '/api/v1/ecocash/webhook',
    bodyText: JSON.stringify({ status: 'COMPLETED', reference: 'ECOCASH-DOES-NOT-EXIST', amount: 10 }),
  });
  assert.equal(cb.status, 404);
});
