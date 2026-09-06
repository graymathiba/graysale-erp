// Industrial-grade HTTP server: JSON API + static POS frontend
import http from 'node:http';
import os from 'node:os';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { PosService } from './pos.js';
import { AccountingService } from './accounting.js';
import { ReportingService } from './reporting.js';
import { autoBackup, backupToLocalFolder } from './backup/backup.js';
import { createOrchestrator } from './agents/index.js';
import { createMessage, ResultStatus, MessageType } from './agents/message.js';
import { AuthService, hashPassword, validatePassword, CAP_RANK, ROLE_RANK } from './auth.js';
import { EventHub } from './events.js';
import { createGsRouter } from './gs/index.js';

const PORT = process.env.PORT || 3000;
const store = new Store();
const pos = new PosService(store);
const acct = new AccountingService(store);
const report = new ReportingService(store);
const orch = createOrchestrator(store, store.db);
const auth = new AuthService(store);
const events = new EventHub();

// Retail (graysale) services — serve routes the main handler does not own.
const gs = createGsRouter(store, auth);

const STATIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const SCHEMA_VERSION = 3;

// ── CORS ────────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function applyCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

// ── Rate limiter ───────────────────────────────────────────────────────
const RATE_WINDOW_MS = 60 * 1000;
const rateBuckets = new Map(); // key -> { count, resetAt }
let rateCleanupTimer = null;

function keyFor(ip, isLogin) {
  return (isLogin ? 'login:' : 'req:') + (ip || 'unknown');
}

function isRateLimited(ip, { isLogin = false } = {}) {
  const limit = isLogin ? 10 : 100;
  const now = Date.now();
  const key = keyFor(ip, isLogin);
  let b = rateBuckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(key, b);
  }
  b.count += 1;
  if (b.count > limit) return true;
  return false;
}

function scheduleRateCleanup() {
  if (rateCleanupTimer) return;
  rateCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of rateBuckets) {
      if (b.resetAt <= now) rateBuckets.delete(k);
    }
    if (rateBuckets.size === 0 && rateCleanupTimer) {
      clearInterval(rateCleanupTimer);
      rateCleanupTimer = null;
    }
  }, 60 * 1000);
  rateCleanupTimer.unref?.();
}

// ── Request logging ────────────────────────────────────────────────────
function logRequest({ method, path, status, durationMs, userId, ip }) {
  try {
    store.db.prepare(
      'INSERT INTO request_log (method, path, status, duration_ms, user_id, ip) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(method, path, status, durationMs, userId ?? null, ip ?? null);
  } catch (_) {}
}

// ── Input validation ───────────────────────────────────────────────────
function requireFields(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') {
      return `MISSING_FIELD:${f}`;
    }
  }
  return null;
}

const json = (res, status, body) => {
  applyCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
  return true;
};

const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket?.remoteAddress ||
  req.connection?.remoteAddress ||
  'unknown';

// Run a message through the orchestrator and map the result to an HTTP response.
function runAgent(domain, payload) {
  const msg = createMessage({
    type: MessageType.COMMAND,
    from: 'api',
    to: '',
    domain,
    payload: payload || {},
  });
  return orch.send(msg);
}

function agentResult(res, result, { okStatus = 200, errorStatus = 400 } = {}) {
  if (result.status === ResultStatus.FAILURE) {
    return json(res, errorStatus, { error: result.error || 'AGENT_FAILURE' });
  }
  return json(res, okStatus, result.data ?? { ok: true });
}

// ── API routes ─────────────────────────────────────────────────────────
async function handleApi(req, res, url) {
  const method = req.method;
  const path = url.pathname.replace(/\/$/, '') || '/';
  const parts = path.split('/').filter(Boolean); // e.g. ['api','v1','products']

  if (parts[0] !== 'api' || parts[1] !== 'v1') return false;

  const started = Date.now();
  const route = parts.slice(2); // after /api/v1/
  const top = route[0];

  // Current user resolved from the Authorization bearer token, when present.
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const currentUser = auth.userForToken(token);
  const requireRole = (capability) => {
    if (!auth.requireCapability(currentUser, capability)) {
      json(res, 403, { error: 'FORBIDDEN: insufficient role' });
      return false;
    }
    return true;
  };

  // ── Request rate limiting ────────────────────────────────────────────
  scheduleRateCleanup();
  const isLogin = top === 'auth' && route[1] === 'login';
  if (isRateLimited(clientIp(req), { isLogin })) {
    json(res, 429, { error: 'RATE_LIMITED' });
    return true;
  }

  // Store a reference to the current user id for use in logging wrappers.
  let responseStatus = 500;

  const respond = (status, body) => {
    responseStatus = status;
    return json(res, status, body);
  };

  // ---------- Auth ----------
  if (top === 'auth') {
    if (method === 'POST' && route[1] === 'login') {
      const b = await readBody(req);
      const result = auth.login({ username: b.username, password: b.password });
      const st = result.ok ? 200 : 401;
      logRequest({ method, path, status: st, durationMs: Date.now() - started, userId: result.user?.id, ip: clientIp(req) });
      return json(res, st, result);
    }
    if (method === 'POST' && route[1] === 'logout') {
      auth.logout(token);
      return json(res, 200, { ok: true });
    }
    if (method === 'GET' && route[1] === 'me') {
      const st = currentUser ? 200 : 401;
      logRequest({ method, path, status: st, durationMs: Date.now() - started, userId: currentUser?.id, ip: clientIp(req) });
      return json(res, st, currentUser ? { user: currentUser } : { error: 'UNAUTHORIZED' });
    }
    return false;
  }

  // ---------- Users (list for managers; management admin only) ----------
  if (top === 'users') {
    if (method === 'GET' && route.length === 1) {
      const view = requireRole('users.view');
      if (!view) return true;
      return respond(200, auth.listUsers());
    }
    if (method === 'POST' && route[1] === 'create') {
      const allowed = requireRole('users.manage');
      if (!allowed) return true;
      const b = await readBody(req);
      try {
        const missing = requireFields(b, ['username', 'password']);
        if (missing) return respond(400, { error: missing });
        if (validatePassword && !validatePassword(b.password)) {
          return respond(400, { error: 'WEAK_PASSWORD: must be 8+ chars with upper, lower and digit' });
        }
        const u = auth.store.db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)')
          .run(b.username, hashPassword(b.password), b.fullName || b.username, b.role || 'cashier');
        auth.audit(currentUser.id, currentUser.username, 'USER_CREATE', 'user', u.lastInsertRowid, b.username);
        return respond(201, { id: u.lastInsertRowid });
      } catch (e) {
        return respond(400, { error: e.message });
      }
    }
    if (method === 'PUT' && route.length === 2) {
      const b = await readBody(req);
      const selfPasswordOnly =
        Number(route[1]) === currentUser.id &&
        Boolean(b.password) && b.role == null && b.active == null && b.fullName == null;
      if (!selfPasswordOnly) {
        const allowed = requireRole('users.manage');
        if (!allowed) return true;
      }
      try {
        const updates = [];
        const vals = [];
        if (b.role != null) { updates.push('role = ?'); vals.push(b.role); }
        if (b.active != null) { updates.push('active = ?'); vals.push(b.active); }
        if (b.fullName != null) { updates.push('full_name = ?'); vals.push(b.fullName); }
        if (b.password) { updates.push('password_hash = ?'); vals.push(hashPassword(b.password)); }
        if (!updates.length) return respond(400, { error: 'NO_FIELDS' });
        vals.push(Number(route[1]));
        auth.store.db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
        auth.audit(currentUser.id, currentUser.username, 'USER_UPDATE', 'user', Number(route[1]), JSON.stringify(b));
        return respond(200, { ok: true });
      } catch (e) {
        return respond(400, { error: e.message });
      }
    }
    // GET /users/:id/capabilities — list all capabilities for a user (role-based + grants)
    if (method === 'GET' && route.length === 3 && route[2] === 'capabilities') {
      const caps = auth.listUserCapabilities(Number(route[1]));
      return respond(200, caps);
    }
    // POST /users/:id/capabilities/grant — grant a capability to a user
    if (method === 'POST' && route.length === 4 && route[2] === 'capabilities' && route[3] === 'grant') {
      const b = await readBody(req);
      if (!b.capability) return respond(400, { error: 'CAPABILITY_REQUIRED' });
      const result = auth.grantCapability(currentUser.id, Number(route[1]), b.capability);
      if (!result.ok) return respond(400, { error: result.error });
      return respond(200, result);
    }
    // POST /users/:id/capabilities/revoke — revoke a capability from a user
    if (method === 'POST' && route.length === 4 && route[2] === 'capabilities' && route[3] === 'revoke') {
      const b = await readBody(req);
      if (!b.capability) return respond(400, { error: 'CAPABILITY_REQUIRED' });
      const result = auth.revokeCapability(currentUser.id, Number(route[1]), b.capability);
      if (!result.ok) return respond(400, { error: result.error });
      return respond(200, result);
    }
    // GET /users/capabilities — list all available capabilities
    if (method === 'GET' && route.length === 2 && route[1] === 'capabilities') {
      const caps = Object.entries(CAP_RANK).map(([name, minRank]) => ({
        name,
        minRole: Object.entries(ROLE_RANK).find(([_, r]) => r === minRank)?.[0] || 'unknown',
      }));
      return respond(200, caps);
    }
    return false;
  }

  // ---------- Audit log (admin only) ----------
  if (top === 'audit') {
    const allowed = requireRole('audit.view');
    if (!allowed) return true;
    if (method === 'GET' && route.length === 1) {
      return respond(200, auth.listAudit(Number(url.searchParams.get('limit')) || 100));
    }
    return false;
  }

  // GET /api/v1/health
  if (top === 'health' && method === 'GET') {
    try {
      const bal = acct.verifyBalanced();
      let agentCount = 0;
      try { agentCount = orch.agents().length; } catch (_) { agentCount = 5; }
      let sessionCount = 0;
      try { sessionCount = store.db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE expires_at > datetime(\'now\')').get().c; } catch (_) {}
      return respond(200, {
        ok: true,
        db: 'connected',
        journalBalanced: bal.balanced,
        agents: agentCount,
        sessions: sessionCount,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        schemaVersion: SCHEMA_VERSION,
      });
    } catch (e) {
      return respond(500, { ok: false, error: e.message });
    }
  }

  // GET /api/v1/events — SSE stream for real-time multi-device sync
  if (top === 'events' && method === 'GET') {
    applyCors(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':\n\n'); // initial heartbeat
    const unsub = events.subscribe((event, data) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
    });
    const alive = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch (_) {} }, 30000);
    req.on('close', () => { clearInterval(alive); unsub(); });
    return true;
  }

  // ---------- Products ----------
  if (top === 'products') {
    if (method === 'GET' && route.length === 1) {
      return respond(200, store.listProducts(url.searchParams.get('all') === '1' ? false : true, {
        search: url.searchParams.get('search'),
        categoryId: url.searchParams.get('categoryId'),
      }));
    }
    if (method === 'POST' && route.length === 1) {
      const allowed = requireRole('products.manage');
      if (!allowed) return true;
      const b = await readBody(req);
      try {
        const missing = requireFields(b, ['name']);
        if (missing) return respond(400, { error: missing });
        const product = gs.catalog.createProduct(b);
        const id = product.id;
        auth.audit(currentUser.id, currentUser.username, 'PRODUCT_CREATE', 'product', id, b.name);
        events.broadcast('products', { action: 'create', id });
        return respond(201, { id });
      }
      catch (e) {
        const st = Number.isInteger(e?.status) ? e.status : 400;
        return respond(st, { error: e.message });
      }
    }
    if (method === 'PUT' && route.length === 2) {
      const allowed = requireRole('products.manage');
      if (!allowed) return true;
      try {
        gs.catalog.updateProduct(Number(route[1]), await readBody(req));
        auth.audit(currentUser.id, currentUser.username, 'PRODUCT_UPDATE', 'product', Number(route[1]), '');
        events.broadcast('products', { action: 'update', id: Number(route[1]) });
        return respond(200, { ok: true });
      } catch (e) {
        const st = Number.isInteger(e?.status) ? e.status : 400;
        return respond(st, { error: e.message });
      }
    }
    if (method === 'GET' && route.length === 2 && route[1] === 'low') {
      return respond(200, store.listLowStock());
    }
  }

  // GET /api/v1/products/by-barcode/:barcode
  if (top === 'products' && route[1] === 'by-barcode' && method === 'GET') {
    const p = store.findProductByBarcode(url.pathname.split('/').pop());
    if (!p) return respond(404, { error: 'NOT_FOUND' });
    return respond(200, p);
  }

  // ---------- Inventory ----------
  if (top === 'inventory') {
    if (method === 'POST' && route[1] === 'adjust') {
      const allowed = requireRole('inventory.adjust');
      if (!allowed) return true;
      const b = await readBody(req);
      try {
        const missing = requireFields(b, ['productId']);
        if (missing) return respond(400, { error: missing });
        const d = b.delta ?? b.qty;
        if (d == null) return respond(400, { error: 'MISSING_FIELD:delta' });
        const n = store.adjustInventory(b.productId, d, b.type || 'ADJUST', b.note || '');
        auth.audit(currentUser.id, currentUser.username, 'INVENTORY_ADJUST', 'product', b.productId, `${b.type}:${d} ${b.note || ''}`);
        events.broadcast('inventory', { action: 'adjust', productId: b.productId, quantity: n });
        return respond(200, { quantity: n, qtyOnHand: n });
      } catch (e) { return respond(400, { error: e.message }); }
    }
    if (method === 'GET' && route[1] === 'movements') {
      const pid = url.searchParams.get('productId');
      return respond(200, report.inventoryMovements(pid ? Number(pid) : null));
    }
    if (method === 'GET' && route.length === 1) {
      const allowed = requireRole('inventory.view');
      if (!allowed) return true;
      return respond(200, store.listProducts());
    }
  }

  // ---------- Customers ----------
  if (top === 'customers') {
    if (method === 'GET' && route.length === 1) {
      return respond(200, gs.customers.list({ search: url.searchParams.get('search') }));
    }
    if (method === 'POST' && route.length === 1) {
      const b = await readBody(req);
      try {
        const missing = requireFields(b, ['name']);
        if (missing) return respond(400, { error: missing });
        const c = gs.customers.create(b);
        const id = c.id;
        events.broadcast('customers', { action: 'create', id });
        return respond(201, { id });
      }
      catch (e) {
        const st = Number.isInteger(e?.status) ? e.status : 400;
        return respond(st, { error: e.message });
      }
    }
    if (method === 'GET' && route.length === 2 && route[1] === 'search') {
      const q = url.searchParams.get('q') || '';
      return respond(200, store.findCustomer(q));
    }
  }

  // ---------- Checkout (POS) ----------
  if (top === 'checkout' && method === 'POST') {
    const allowed = requireRole('pos.checkout');
    if (!allowed) return true;
    const b = await readBody(req);
    try {
      const missing = requireFields(b, ['items']);
      if (missing) return respond(400, { error: missing });

      // --- Split payments support (Tier 2.2) ---
      let payload = { ...b };
      if (Array.isArray(b.payments) && b.payments.length > 0) {
        // Compute the expected total without committing a sale.
        const breakdown = pos.validateItems(b.items);
        if (breakdown.error) return respond(400, { error: breakdown.error });
        const lines = breakdown.lines;
        const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
        const redeem = b.redeemPoints ? store.centsForPoints(b.redeemPoints) : 0;
        const discount = (b.discountCents || 0) + redeem;
        const taxable = lines.reduce((s, l) => s + l.taxCents, 0);
        const totalCents = subtotal - Math.min(discount, subtotal) + taxable;

        const paid = b.payments.reduce((s, p) => s + Number(p.amountCents || 0), 0);
        if (paid < totalCents) {
          return respond(400, { error: 'PAYMENTS_BELOW_TOTAL' });
        }
        const cashSplit = b.payments.find(p => p.method === 'cash');
        const cashReceived =
          cashSplit && cashSplit.amountCents > totalCents ? cashSplit.amountCents : totalCents;
        payload = {
          ...b,
          cashReceivedCents: cashReceived,
          paymentMethod: b.payments.map(p => p.method).join('+') || 'cash',
          payments: undefined,
        };
      }

      const result = await pos.checkout(payload);
      if (!result.ok) return respond(400, { error: result.error });
      events.broadcast('sale', { action: 'create', saleId: result.saleId, receiptNo: result.receiptNo, totalCents: result.totalCents, items: (result.lines || []).map(l => ({ productId: l.productId, qty: l.qty })) });
      events.broadcast('dashboard', {});
      return respond(200, result);
    } catch (e) {
      return respond(500, { error: e.message });
    }
  }

  // ---------- Returns / Refunds (Tier 2.1) ----------
  if (top === 'returns') {
    if (method === 'GET' && route.length === 1) {
      try {
        const rows = store.db.prepare(
          `SELECT r.*, s.receipt_no
           FROM returns r JOIN sales s ON s.id = r.sale_id
           ORDER BY r.created_at DESC`
        ).all();
        return respond(200, rows);
      } catch (e) { return respond(500, { error: e.message }); }
    }
    if (method === 'POST' && route.length === 1) {
      const b = await readBody(req);
      try {
        const missing = requireFields(b, ['saleId', 'items', 'reason']);
        if (missing) return respond(400, { error: missing });
        if (!Array.isArray(b.items) || b.items.length === 0) {
          return respond(400, { error: 'MISSING_FIELD:items' });
        }
        const db = store.db;
        const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(Number(b.saleId));
        if (!sale) return respond(404, { error: 'SALE_NOT_FOUND' });
        if (sale.status !== 'complete') return respond(400, { error: `SALE_STATUS:${sale.status}` });

        let subtotalCents = 0;
        let taxCents = 0;

        db.exec('BEGIN');
        const returnNo = `RET-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        const insReturn = db.prepare(
          'INSERT INTO returns (sale_id, return_no, subtotal_cents, tax_cents, total_cents, reason) VALUES (?, ?, ?, ?, ?, ?)'
        );
        const insItem = db.prepare(
          `INSERT INTO return_items (return_id, sale_item_id, product_id, qty, unit_price_cents, line_total_cents, tax_cents)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        const updStock = db.prepare('UPDATE inventory SET quantity = quantity + ?, updated_at = datetime(\'now\') WHERE product_id = ?');
        const insMove = db.prepare(`INSERT INTO inventory_movements (product_id, quantity, type, note) VALUES (?, ?, 'RETURN', ?)`);

        const returnRes = insReturn.run(sale.id, returnNo, 0, 0, 0, b.reason);
        const returnId = returnRes.lastInsertRowid;

        for (const it of b.items) {
          const saleItem = db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?').get(Number(it.saleItemId), sale.id);
          if (!saleItem) throw new Error(`SALE_ITEM_NOT_FOUND:${it.saleItemId}`);
          const qty = Number(it.qty);
          if (!qty || qty <= 0) throw new Error(`BAD_QTY:${it.saleItemId}`);
          if (qty > saleItem.qty) throw new Error(`RETURN_QTY_EXCEEDS:${it.saleItemId}`);
          const lineTotal = saleItem.unit_price_cents * qty;
          const lineTax = saleItem.tax_cents * qty / saleItem.qty;
          subtotalCents += lineTotal;
          taxCents += lineTax;
          insItem.run(returnId, saleItem.id, saleItem.product_id, qty, saleItem.unit_price_cents, lineTotal, lineTax);
          updStock.run(qty, saleItem.product_id);
          insMove.run(saleItem.product_id, qty, returnNo);
        }

        const totalCents = subtotalCents + taxCents;
        db.prepare('UPDATE returns SET subtotal_cents = ?, tax_cents = ?, total_cents = ? WHERE id = ?')
          .run(subtotalCents, taxCents, totalCents, returnId);

        db.prepare("UPDATE sales SET status = 'returned' WHERE id = ?").run(sale.id);

        // Post reversal journal entry (double-entry).
        const entryNo = `JE-RET-${Date.now()}`;
        const desc = `Return ${returnNo} (sale ${sale.receipt_no})`;
        const entry = db.prepare('INSERT INTO journal_entries (entry_no, reference, description) VALUES (?, ?, ?)')
          .run(entryNo, returnNo, desc);
        const entryId = entry.lastInsertRowid;
        const revenue = acct.accountBalance && store.db.prepare('SELECT id FROM accounts WHERE name LIKE ? OR code = ?').get('%revenue%', '4000');
        const cashAcct = store.db.prepare('SELECT id FROM accounts WHERE code = ?').get('1000');
        const taxAcct = store.db.prepare('SELECT id FROM accounts WHERE code = ?').get('2060');
        if (revenue) {
          store.db.prepare('INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?, ?, ?, ?)').run(entryId, revenue.id, subtotalCents, 0);
          if (cashAcct) store.db.prepare('INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?, ?, ?, ?)').run(entryId, cashAcct.id, 0, totalCents);
          if (taxAcct) store.db.prepare('INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?, ?, ?, ?)').run(entryId, taxAcct.id, 0, taxCents);
        }

        db.exec('COMMIT');

        auth.audit(currentUser.id, currentUser.username, 'RETURN_CREATE', 'return', returnId, returnNo);
        events.broadcast('dashboard', {});
        return respond(201, { id: returnId, returnNo, subtotalCents, taxCents, totalCents, status: 'complete' });
      } catch (e) {
        try { store.db.exec('ROLLBACK'); } catch (_) {}
        return respond(400, { error: e.message });
      }
    }
  }

  // ---------- Sales ----------
  if (top === 'sales') {
    if (method === 'GET' && route.length === 1) return respond(200, report.salesHistory());
    if (method === 'POST' && route[1] === 'void') {
      const allowed = requireRole('sales.void');
      if (!allowed) return true;
      const b = await readBody(req);
      try {
        const r = pos.voidSale(b.saleId, b.reason);
        if (r.ok) {
          auth.audit(currentUser.id, currentUser.username, 'SALE_VOID', 'sale', b.saleId, b.reason || '');
          events.broadcast('sale', { action: 'void', saleId: b.saleId });
          events.broadcast('dashboard', {});
        }
        return r.ok ? respond(200, r) : respond(400, r);
      } catch (e) { return respond(500, { error: e.message }); }
    }
  }

  // ---------- Dashboard / Reports ----------
  if (top === 'dashboard' && method === 'GET') {
    const ts = report.todayStats();
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
    return respond(200, {
      ...ts,
      today: { ...(ts.today || {}), ...gs.reports.salesSummary() },
      byDay: gs.reports.salesByDay({ from, to }),
      lowStock: gs.catalog.lowStock().slice(0, 8),
    });
  }
  if (top === 'reports') {
    const range = { startDate: url.searchParams.get('startDate'), endDate: url.searchParams.get('endDate') };
    try {
      if (method === 'GET' && route[1] === 'top-products') {
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        if (from) return respond(200, gs.reports.topProducts(10, { from, to }));
        return respond(200, report.topProducts(10, range));
      }
      if (method === 'GET' && route[1] === 'by-category') {
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        if (from) return respond(200, gs.reports.salesByCategory({ from, to }));
        return respond(200, report.salesByCategory(range));
      }
      if (method === 'GET' && route[1] === 'daily') return respond(200, report.dailySummary(range));
      if (method === 'GET' && route[1] === 'history') return respond(200, report.salesHistory(range));
      // ---- Advanced reports (Tier 4.1 - 4.6) ----
      if (method === 'GET' && route[1] === 'pnl') return respond(200, acct.profitAndLoss(range));
      if (method === 'GET' && route[1] === 'balance-sheet') return respond(200, acct.balanceSheet(range));
      if (method === 'GET' && route[1] === 'aging') return respond(200, acct.agingBuckets());
      if (method === 'GET' && route[1] === 'compare-pnl') {
        const n = Math.max(1, Number(url.searchParams.get('periods')) || 6);
        const now = new Date();
        const periods = [];
        for (let i = n - 1; i >= 0; i--) {
          const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
          periods.push({
            label: start.toISOString().slice(0, 7),
            startDate: start.toISOString().slice(0, 10),
            endDate: end.toISOString().slice(0, 10),
          });
        }
        return respond(200, acct.comparePnl({ periods }));
      }
      if (method === 'GET' && route[1] === 'margins') return respond(200, acct.profitMargins());
      if (method === 'GET' && route[1] === 'tax-summary') return respond(200, acct.taxSummary(range));
      if (method === 'GET' && route[1] === 'cashier-stats') return respond(200, report.cashierStats(range));
      if (method === 'GET' && route[1] === 'product-margins') return respond(200, report.productMargins());
    } catch (e) { return respond(500, { error: e.message }); }
  }

  // ---------- Accounting ----------
  if (top === 'accounting') {
    const allowed = requireRole('accounting.view');
    if (!allowed) return true;
    try {
      if (method === 'GET' && route[1] === 'chart') return respond(200, acct.chartOfAccounts());
      if (method === 'GET' && route[1] === 'ledger') {
        const code = url.searchParams.get('account');
        return respond(200, acct.ledger(code));
      }
      if (method === 'GET' && route[1] === 'trial-balance') return respond(200, acct.trialBalance());
      if (method === 'GET' && route[1] === 'pl') return respond(200, acct.profitAndLoss());
      if (method === 'GET' && route[1] === 'balance-sheet') return respond(200, acct.balanceSheet());
      if (method === 'GET' && route[1] === 'verify') return respond(200, acct.verifyBalanced());
    } catch (e) { return respond(500, { error: e.message }); }
  }

  // ---------- Backup ----------
  if (top === 'backup' && method === 'POST') {
    const allowed = requireRole('backup.run');
    if (!allowed) return true;
    try {
      const result = await backupToLocalFolder().catch(e => ({ ok: false, error: e.message }));
      if (result.ok) auth.audit(currentUser.id, currentUser.username, 'BACKUP', null, null, result.dest);
      return respond(result.ok ? 200 : 500, result);
    } catch (e) { return respond(500, { error: e.message }); }
  }

  // ---------- Agents (Tier 1.4 — now require auth) ----------
  if (top === 'agents') {
    const allowed = requireRole('agents.run');
    if (!allowed) return true;
    try {
      // GET /api/v1/agents — list registered agents
      if (method === 'GET' && route.length === 1) {
        return respond(200, orch.agents());
      }
      // GET /api/v1/agents/history — orchestrator message history
      if (method === 'GET' && route[1] === 'history') {
        return respond(200, orch.history(Number(url.searchParams.get('limit')) || 50));
      }
      // POST /api/v1/agents/message — send message to an agent via orchestrator
      if (method === 'POST' && route[1] === 'message') {
        const b = await readBody(req);
        const missing = requireFields(b, ['domain']);
        if (missing) return respond(400, { error: missing });
        const msg = createMessage({ type: b.type || MessageType.COMMAND, from: b.from || 'api', to: b.to || '', domain: b.domain, payload: b.payload || {}, metadata: b.metadata || {} });
        const result = await orch.send(msg);
        return respond(result.status === 'FAILURE' ? 400 : 200, result);
      }
      // POST /api/v1/agents/flow — execute a multi-step saga flow
      if (method === 'POST' && route[1] === 'flow') {
        const b = await readBody(req);
        if (!Array.isArray(b.steps)) return respond(400, { error: 'steps must be an array' });
        const result = await orch.flow(b.steps);
        return respond(result.ok ? 200 : 400, result);
      }
    } catch (e) { return respond(500, { error: e.message }); }
  }

  // ---------- Employees (Tier 2.3) ----------
  if (top === 'employees') {
    if (method === 'GET' && route.length === 1) {
      const r = await runAgent('hr.list', {});
      return agentResult(res, r, { okStatus: 200 });
    }
    if (method === 'GET' && route.length === 3 && route[2] === 'benefits') {
      const r = await runAgent('hr.list_benefits', { employeeId: Number(route[1]) });
      return agentResult(res, r, { okStatus: 200 });
    }
    if (method === 'POST' && route.length === 1) {
      const allowed = requireRole('users.manage');
      if (!allowed) return true;
      const b = await readBody(req);
      const missing = requireFields(b, ['name', 'role']);
      if (missing) return respond(400, { error: missing });
      const r = await runAgent('hr.create', b);
      return agentResult(res, r, { okStatus: 201, errorStatus: 400 });
    }
    if (method === 'PUT' && route.length === 2) {
      const allowed = requireRole('users.manage');
      if (!allowed) return true;
      const b = await readBody(req);
      const r = await runAgent('hr.update', { id: Number(route[1]), ...b });
      return agentResult(res, r, { okStatus: 200, errorStatus: 400 });
    }
    if (method === 'POST' && route.length === 3 && route[2] === 'benefits') {
      const allowed = requireRole('users.manage');
      if (!allowed) return true;
      const b = await readBody(req);
      const missing = requireFields(b, ['planName']);
      if (missing) return respond(400, { error: missing });
      const r = await runAgent('hr.enroll', {
        employeeId: Number(route[1]),
        planName: b.planName,
        provider: b.provider,
        monthlyCost: b.monthlyCost,
        employerContribution: b.employerContribution,
      });
      return agentResult(res, r, { okStatus: 201, errorStatus: 400 });
    }
  }

  // ---------- Invoices (Tier 2.5) ----------
  if (top === 'invoices') {
    try {
      if (method === 'GET' && route.length === 1) {
        const type = url.searchParams.get('type');
        const status = url.searchParams.get('status');
        const conds = [];
        const params = [];
        if (type) { conds.push('type = ?'); params.push(type); }
        if (status) { conds.push('status = ?'); params.push(status); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        const rows = store.db.prepare(
          `SELECT * FROM invoices ${where} ORDER BY created_at DESC`
        ).all(...params);
        return respond(200, rows);
      }
      if (method === 'POST' && route.length === 1) {
        const b = await readBody(req);
        const missing = requireFields(b, ['type', 'items']);
        if (missing) return respond(400, { error: missing });
        if (!Array.isArray(b.items) || b.items.length === 0) return respond(400, { error: 'MISSING_FIELD:items' });
        const r = await runAgent('finance.invoice', b);
        if (r.status === ResultStatus.FAILURE) return respond(400, { error: r.error });
        if (r.status === ResultStatus.PENDING_APPROVAL) return respond(202, { status: 'PENDING_APPROVAL', approvalId: r.approvalId, risk: r.risk });
        return respond(201, r.data ?? r);
      }
      if (method === 'GET' && route.length === 2) {
        const inv = store.db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(route[1]));
        if (!inv) return respond(404, { error: 'INVOICE_NOT_FOUND' });
        const items = store.db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(inv.id);
        return respond(200, { ...inv, items });
      }
      if (method === 'POST' && route.length === 3 && route[2] === 'pay') {
        const b = await readBody(req);
        const missing = requireFields(b, ['amountCents']);
        if (missing) return respond(400, { error: missing });
        const r = await runAgent('finance.pay', { invoiceId: Number(route[1]), amountCents: Number(b.amountCents), method: b.method || 'cash' });
        if (r.status === ResultStatus.FAILURE) return respond(404, { error: r.error || 'INVOICE_NOT_FOUND' });
        return respond(200, r.data ?? r);
      }
    } catch (e) { return respond(500, { error: e.message }); }
  }

  // ---------- Quotes (Tier 2.6) ----------
  if (top === 'quotes') {
    try {
      if (method === 'GET' && route.length === 1) {
        const status = url.searchParams.get('status');
        const r = await runAgent('quote.list', { status, customerId: url.searchParams.get('customerId') });
        return agentResult(res, r, { okStatus: 200 });
      }
      if (method === 'POST' && route.length === 1) {
        const b = await readBody(req);
        const missing = requireFields(b, ['items']);
        if (missing) return respond(400, { error: missing });
        if (!Array.isArray(b.items) || b.items.length === 0) return respond(400, { error: 'MISSING_FIELD:items' });
        const r = await runAgent('quote.generate', b);
        return agentResult(res, r, { okStatus: 201, errorStatus: 400 });
      }
      if (method === 'GET' && route.length === 2) {
        const r = await runAgent('quote.get', { quoteId: Number(route[1]) });
        if (r.status === ResultStatus.FAILURE) return respond(404, { error: r.error });
        return respond(200, r.data ?? r);
      }
      if (method === 'PUT' && route.length === 3 && route[2] === 'accept') {
        const r = await runAgent('quote.accept', { quoteId: Number(route[1]) });
        if (r.status === ResultStatus.FAILURE) return respond(400, { error: r.error });
        events.broadcast('dashboard', {});
        return respond(200, r.data ?? r);
      }
      if (method === 'PUT' && route.length === 3 && route[2] === 'decline') {
        const r = await runAgent('quote.decline', { quoteId: Number(route[1]) });
        if (r.status === ResultStatus.FAILURE) return respond(400, { error: r.error });
        return respond(200, r.data ?? r);
      }
    } catch (e) { return respond(500, { error: e.message }); }
  }

  // ---------- Shipments (Tier 2.7) ----------
  if (top === 'shipments') {
    try {
      if (method === 'GET' && route.length === 1) {
        const status = url.searchParams.get('status');
        const r = await runAgent('scm.list_shipments', { status });
        return agentResult(res, r, { okStatus: 200 });
      }
      if (method === 'POST' && route.length === 1) {
        const b = await readBody(req);
        const missing = requireFields(b, ['carrier']);
        if (missing) return respond(400, { error: missing });
        const r = await runAgent('scm.create', b);
        return agentResult(res, r, { okStatus: 201, errorStatus: 400 });
      }
      if (method === 'GET' && route.length === 2) {
        const r = await runAgent('scm.track', { trackingNo: route[1] });
        if (r.status === ResultStatus.FAILURE) return respond(404, { error: r.error });
        return respond(200, r.data ?? r);
      }
      if (method === 'PUT' && route.length === 3 && route[2] === 'status') {
        const b = await readBody(req);
        const missing = requireFields(b, ['status']);
        if (missing) return respond(400, { error: missing });
        const r = await runAgent('scm.update', { trackingNo: route[1], status: b.status, actualArrival: b.actualArrival });
        if (r.status === ResultStatus.FAILURE) return respond(404, { error: r.error });
        return respond(200, r.data ?? r);
      }
    } catch (e) { return respond(500, { error: e.message }); }
  }

  // ---------- Purchase Orders transitions (Tier 2.9) ----------
  if (top === 'purchase-orders') {
    try {
      if (method === 'POST' && route.length === 3 && route[2] === 'partial-receive') {
        const b = await readBody(req);
        const missing = requireFields(b, ['items']);
        if (missing) return respond(400, { error: missing });
        if (!Array.isArray(b.items)) return respond(400, { error: 'MISSING_FIELD:items' });
        const r = await runAgent('po.partial_receive', { poId: Number(route[1]), items: b.items });
        if (r.status === ResultStatus.FAILURE) return respond(400, { error: r.error });
        events.broadcast('inventory', { action: 'po-partial-receive', poId: Number(route[1]) });
        return respond(200, r.data ?? r);
      }
      if (method === 'POST' && route.length === 3 && route[2] === 'cancel') {
        const r = await runAgent('po.cancel', { poId: Number(route[1]) });
        if (r.status === ResultStatus.FAILURE) return respond(400, { error: r.error });
        return respond(200, r.data ?? r);
      }
    } catch (e) { return respond(500, { error: e.message }); }
  }

  // ---------- Approval workflow (Tier 6.2) ----------
  if (top === 'approvals') {
    try {
      if (method === 'GET' && route.length === 1) {
        const rows = store.db.prepare(
          'SELECT * FROM approval_queue WHERE status = ? ORDER BY created_at DESC'
        ).all('pending');
        return respond(200, rows);
      }
      if (method === 'POST' && route.length === 3 && route[2] === 'approve') {
        const result = orch.approve(route[1], currentUser?.username || 'api');
        return respond(200, result);
      }
      if (method === 'POST' && route.length === 3 && route[2] === 'reject') {
        const b = await readBody(req);
        const result = orch.reject(route[1], currentUser?.username || 'api', b.reason);
        return respond(200, result);
      }
    } catch (e) { return respond(500, { error: e.message }); }
  }

  // ---------- Retail (graysale) fallback ----------
  // Runs for any /api/v1/* route the main handler does not own. The gs router
  // enforces its own capabilities; returns true when it matched (even on error).
  const gsHandled = await gs.handle(req, res, url, route, currentUser);
  if (gsHandled) return true;

  return false;
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const started = Date.now();

  // Handle CORS preflight for all paths.
  if (req.method === 'OPTIONS') {
    applyCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  applyCors(res);

  try {
    const handled = await handleApi(req, res, url);
    if (handled) {
      // Log only API requests. SSE/static skip logging here.
      if (url.pathname.startsWith('/api/v1/')) {
        logRequest({ method: req.method, path: url.pathname, status: res.statusCode || 200, durationMs: Date.now() - started, userId: null, ip: clientIp(req) });
      }
      return;
    }
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message });
    return;
  }

  // Serve static frontend from /public
  let filePath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  let abs = join(STATIC_DIR, filePath);
  if (!existsSync(abs) || statSync(abs).isDirectory()) {
    abs = join(STATIC_DIR, 'index.html');
  }
  return serveStatic(res, abs);
});

function serveStatic(res, abs) {
  try {
    const data = readFileSync(abs);
    const ext = extname(abs);
    res.writeHead(200, { 'Content-Type': (MIME[ext] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'NOT_FOUND' });
  }
}

server.listen(PORT, '0.0.0.0', () => {
  auth.ensureDefaultAdmin();

  // Start automatic backups every 4 hours (Tier 5.1).
  try {
    autoBackup({ store });
    console.log('Auto-backup scheduled every 4 hours.');
  } catch (e) {
    console.error('Failed to start auto-backup:', e.message);
  }

  console.log(`SuperMart POS running at http://localhost:${PORT}`);
  const ifaces = Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal);
  if (ifaces.length > 0) {
    console.log('--- Access from other devices on the same Wi-Fi/LAN: ---');
    ifaces.forEach(i => console.log(`  http://${i.address}:${PORT}`));
    console.log('Open the URL above on your phone to use both screens live-synced.');
  }
});
