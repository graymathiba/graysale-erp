import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { createHttpServer } from '../src/http/routes.js';
import { seedCatalog } from './helpers.js';

// True end-to-end: real sockets, real request parsing, real security headers.
// Complements the mock-req harness used by the other HTTP tests — this one
// exercises server.js's transport layer minus its process lifecycle.

process.env.LOG_REQUESTS = '0';

let app;
let server;
let base;

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'graysale-e2e-'));
  app = createApp({ dbPath: join(dir, 'e2e.db') });
  // Fresh tenants start unactivated (licensing gate) — same as other HTTP tests.
  app.db
    .prepare("UPDATE tenants SET status = 'ACTIVE' WHERE id = (SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1)")
    .run();
  const handler = createHttpServer(app);
  server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
}

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  try {
    app?.db.close();
  } catch {
    /* already closed */
  }
});

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, data, headers: res.headers };
}

test('happy path: login → open shift → sell → report → Z-close → backup', async () => {
  await boot();
  const { A } = seedCatalog(app); // catalog is data, not the path under test

  // --- auth ---
  const bad = await call('/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
  assert.equal(bad.status, 401);

  const login = await call('/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(login.status, 200);
  assert.equal(login.data.ok, true);
  const token = login.data.token;
  assert.ok(token);

  // Security headers travel on the real wire.
  assert.equal(login.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(login.headers.get('content-security-policy'));

  // Unauthenticated calls are refused.
  assert.equal((await call('/orders')).status, 401);

  // --- shift ---
  const open = await call('/eod/open', { method: 'POST', token, body: { openingCashCents: 5000 } });
  assert.equal(open.status, 201, JSON.stringify(open.data));
  assert.equal(open.data.status, 'OPEN');
  const shiftId = open.data.id;

  // Second open for the same cashier conflicts.
  const again = await call('/eod/open', { method: 'POST', token, body: {} });
  assert.equal(again.status, 409);

  // --- sale (the same payload the web terminal sends) ---
  const sell = await call('/pos/sell', {
    method: 'POST',
    token,
    body: {
      items: [{ productId: A.id, qty: 2 }],
      payments: [{ method: 'CASH', amountCents: 100_000 }],
      orderDiscountPercent: 0,
    },
  });
  assert.equal(sell.status, 200, JSON.stringify(sell.data));
  assert.match(sell.data.doc_no, /^SALE-/);
  assert.ok(sell.data.total_cents > 0);

  // Double-spend guard: stock actually moved and the books balance.
  assert.equal(app.catalog.available(A.id), 8);
  const v = app.accounting.verify();
  assert.ok(v.balanced, `journal unbalanced: ${v.debits} != ${v.credits}`);

  // --- reporting + close ---
  const current = await call('/eod/current', { token });
  assert.equal(current.status, 200);
  assert.equal(current.data.id, shiftId);

  const x = await call(`/eod/report/${shiftId}`, { token });
  assert.equal(x.status, 200);
  assert.equal(x.data.sale_count, 1);

  const z = await call(`/eod/report/${shiftId}/z`, { method: 'POST', token, body: { countedCashCents: 0 } });
  assert.equal(z.status, 200, JSON.stringify(z.data));
  assert.equal(z.data.shift.status, 'CLOSED');

  const closed = await call('/eod/current', { token });
  assert.equal(closed.status, 200);
  assert.equal(closed.data, null); // no open shift left

  // --- backups over HTTP ---
  const bak = await call('/settings/backup', { method: 'POST', token });
  assert.equal(bak.status, 200, JSON.stringify(bak.data));
  assert.equal(bak.data.ok, true);
  assert.ok(bak.data.bytes > 0);

  const list = await call('/settings/backups', { token });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data) && list.data.length >= 1);
  assert.equal(list.data[0].file, bak.data.file);

  // Backup endpoints are admin-only even when authenticated.
  assert.equal((await call('/settings/backup', { method: 'POST' })).status, 401);
});
