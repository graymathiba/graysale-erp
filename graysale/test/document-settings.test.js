import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { createHttpServer } from '../src/http/routes.js';

// Document settings + device printer discovery over the real HTTP wire.

process.env.LOG_REQUESTS = '0';

let app;
let server;
let base;

async function boot() {
  // Each test gets a fresh app; close the previous socket/DB so the runner
  // does not hang on lingering listeners.
  server?.closeAllConnections?.();
  server?.close();
  try {
    app?.db.close();
  } catch {
    /* already closed */
  }
  const dir = mkdtempSync(join(tmpdir(), 'graysale-docset-'));
  app = createApp({ dbPath: join(dir, 'docset.db') });
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
  return { status: res.status, data };
}

async function login() {
  const r = await call('/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.token;
}

test('document settings round-trip through GET/POST /settings', async () => {
  await boot();
  const token = await login();

  const initial = await call('/settings', { token });
  assert.equal(initial.status, 200);
  assert.ok('quoteValidityDays' in initial.data);
  assert.ok('invoiceFooter' in initial.data);
  assert.ok('quoteFooter' in initial.data);

  const saved = await call('/settings', {
    method: 'POST',
    token,
    body: {
      quoteValidityDays: 21,
      invoiceFooter: 'Goods sold are not returnable after 7 days.',
      quoteFooter: 'Prices valid while stocks last.',
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  const after = await call('/settings', { token });
  assert.equal(after.data.quoteValidityDays, '21');
  assert.equal(after.data.invoiceFooter, 'Goods sold are not returnable after 7 days.');
  assert.equal(after.data.quoteFooter, 'Prices valid while stocks last.');
});

test('GET /printers/system is admin-only and always answers an array', async () => {
  await boot();
  assert.equal((await call('/printers/system')).status, 401);

  const token = await login();
  const r = await call('/printers/system', { token });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data), 'discovery degrades to [] when unavailable');
  for (const p of r.data) {
    assert.equal(typeof p.name, 'string');
    assert.ok(['USB', 'Bluetooth', 'Network', 'Serial'].includes(p.connection));
    assert.equal(typeof p.port, 'string');
  }
});

test('quotes list and convert keep the A4 document contract', async () => {
  await boot();
  const token = await login();

  // Quote creation is a POS action; store the required catalog shape directly.
  const { seedCatalog } = await import('./helpers.js');
  const { A } = seedCatalog(app);

  const quote = await call('/pos/quote', {
    method: 'POST',
    token,
    body: { items: [{ productId: A.id, qty: 1 }] },
  });
  assert.equal(quote.status, 200, JSON.stringify(quote.data));
  assert.match(quote.data.doc_no, /^QUOTE-/);
  assert.equal(quote.data.type, 'QUOTE');

  const list = await call('/orders?type=QUOTE', { token });
  assert.equal(list.status, 200);
  assert.ok(list.data.some((o) => o.id === quote.data.id));

  const single = await call(`/orders/${quote.data.id}`, { token });
  assert.equal(single.status, 200);
  assert.ok(Array.isArray(single.data.lines) && single.data.lines.length === 1);
  assert.ok(single.data.lines[0].product_name);

  const converted = await call(`/pos/quote/${quote.data.id}/convert`, {
    method: 'POST',
    token,
    body: { payments: [{ method: 'CASH', amountCents: quote.data.total_cents }] },
  });
  assert.equal(converted.status, 200, JSON.stringify(converted.data));
  assert.match(converted.data.doc_no, /^SALE-/);
});
