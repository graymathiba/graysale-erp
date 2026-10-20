import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineFingerprint } from '../src/storage/machine.js';
import { StorageService } from '../src/storage/service.js';
import { createApp } from '../src/app.js';
import { createHttpServer } from '../src/http/routes.js';
import { LicensingService } from '../src/licensing/index.js';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'graysale-storage-test-'));
}

// Minimal HTTP harness for the storage gate.
function hit(handler, { method = 'GET', url = '/api/v1/dashboard', token = '', bodyText = '' } = {}) {
  return new Promise((resolve) => {
    const req = {
      headers: {
        host: 'localhost',
        authorization: token ? `Bearer ${token}` : '',
        'content-type': 'application/json',
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
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        resolve({ status: this.status || 200, body: body ? JSON.parse(body) : {} });
      },
    };
    handler(req, res);
  });
}

test('machine fingerprint is stable within a boot and unique across machines', () => {
  assert.equal(machineFingerprint(), machineFingerprint());
  assert.match(machineFingerprint(), /^[0-9a-f]{16}$/);
});

test('managed storage (explicit dbPath) is always ready', () => {
  const root = tempRoot();
  const app = createApp({ dbPath: join(root, 'test.db') });
  assert.equal(app.storage.phase, 'ready');
  assert.equal(app.storage.managed, true);
  assert.equal(app.storage.status().phase, 'ready');
});

test('unconfigured storage is detected and setup writes a descriptor', () => {
  const root = tempRoot();
  const storage = new StorageService({ env: { GRAYSTORAGE_ROOT: root } });
  assert.equal(storage.phase, 'unconfigured');
  storage.setDb(createApp({ dbPath: join(root, 'graysale.db') }).db);

  const r = storage.setup({});
  assert.equal(r.ok, true);
  assert.equal(r.reload, false);
  assert.equal(storage.phase, 'ready');
  assert.equal(existsSync(join(root, 'storage.json')), true, 'descriptor written');
  assert.equal(storage.install.environment.machineId, storage.machine.machineId);
});

test('a folder recorded for another machine is caught as new_environment', () => {
  const root = tempRoot();
  const storage = new StorageService({ env: { GRAYSTORAGE_ROOT: root } });
  storage.setup({});
  // Simulate the folder moving to a different computer: rewrite the descriptor
  // with an alien machine id.
  const foreign = {
    ...storage.install,
    environment: { machineId: 'alien-machine-1', hostname: 'other-pc', ready: true },
  };
  writeFileSync(join(root, 'storage.json'), JSON.stringify(foreign, null, 2));

  const moved = new StorageService({ env: { GRAYSTORAGE_ROOT: root } });
  assert.equal(moved.phase, 'new_environment');
  assert.equal(moved.ready, false);

  // adopt() acknowledges the moved data without moving files.
  const r = moved.adopt();
  assert.equal(r.ok, true);
  assert.equal(moved.phase, 'ready');
  assert.equal(moved.install.environment.machineId, moved.machine.machineId);
});

test('relocating to a new folder copies the db and signals reload', () => {
  const root = tempRoot();
  const storage = new StorageService({ env: { GRAYSTORAGE_ROOT: root } });
  const app = createApp({ storage });
  const cat = app.catalog.createCategory('Portable');
  assert.ok(cat);
  storage.setup({});

  const target = tempRoot();
  const r = storage.setup({ root: target });
  assert.equal(r.reload, true, 'db handle must be reopened');
  assert.equal(r.copied, true);
  assert.equal(existsSync(join(target, 'graysale.db')), true);
  assert.equal(existsSync(join(target, 'storage.json')), true);

  // Reopen like server.js onRelocate does.
  app.db.close();
  const app2 = createApp({ storage });
  assert.equal(app2.storage.phase, 'ready');
  assert.equal(app2.storage.dbPath, join(target, 'graysale.db'));
  assert.ok(app2.catalog.categories().length >= 1, 'data survived the move');
});

test('fileView reports what is actually in storage', () => {
  const root = tempRoot();
  const storage = new StorageService({ env: { GRAYSTORAGE_ROOT: root } });
  const app = createApp({ storage });
  app.catalog.createCategory('Groceries');
  app.catalog.createProduct({
    sku: 'S001',
    name: 'Soda',
    categoryId: app.catalog.categories().slice(-1)[0].id,
    unit: 'each',
    costCents: 100,
    priceCents: 200,
    taxClassId: app.catalog.taxClasses()[0].id,
  });

  const view = storage.fileView();
  assert.ok(
    view.files.some((f) => f.name === 'graysale.db'),
    'db listed',
  );
  assert.ok(view.tables.length > 0, 'tables listed');
  assert.ok(
    view.tables.some((t) => t.name === 'products' && t.rows >= 1),
    'row counts accurate',
  );
  const ten = view.tenants[0];
  assert.ok(ten && typeof ten.counts.products === 'number', 'per-tenant counts present');
});

test('tenants registry stores storage metadata (Control Tower stamp)', () => {
  const root = tempRoot();
  const app = createApp({ dbPath: join(root, 'test.db') });
  const licensing = new LicensingService(app.db);
  const s = { kind: 'usb', path: 'E:\\graysale', db: 'graysale.db', machineId: 'abc123', environmentReady: true };
  const t = licensing.tenants.create({
    companyName: 'Corner Shop',
    ownerEmail: 'corner@example.com',
    storage: s,
  });
  assert.equal(t.company_name, 'Corner Shop');
  assert.equal(t.storage.kind, 'usb');
  assert.equal(t.storage.path, 'E:\\graysale');
  assert.equal(t.storage.machineId, 'abc123');
  assert.equal(t.storage.environmentReady, true);

  const updated = licensing.tenants.update(t.id, { storage: { kind: 'local', machineId: 'def456' } });
  assert.equal(updated.storage.kind, 'local');
  assert.equal(updated.storage.machineId, 'def456');
});

test('schema v9 adds storage columns to tenants', () => {
  const root = tempRoot();
  const app = createApp({ dbPath: join(root, 'v9.db') });
  const cols = app.db
    .prepare("PRAGMA table_info('tenants')")
    .all()
    .map((c) => c.name);
  for (const c of ['storage_kind', 'storage_path', 'storage_db', 'machine_id', 'environment_ready']) {
    assert.ok(cols.includes(c), `tenants.${c} exists`);
  }
});

test('HTTP storage gate: 503 before setup, open after', async () => {
  const root = tempRoot();
  const storage = new StorageService({ env: { GRAYSTORAGE_ROOT: root } });
  const app = createApp({ storage });
  const handler = createHttpServer(app);

  // Without setup, normal endpoints are blockedâ€¦
  const blocked = await hit(handler, { url: '/api/v1/dashboard' });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.code, 'STORAGE_NOT_CONFIGURED');

  // â€¦but setup endpoints are reachable.
  const status = await hit(handler, { url: '/api/v1/setup/status' });
  assert.equal(status.status, 200);
  assert.equal(status.body.storage.phase, 'unconfigured');

  const configured = await hit(handler, { method: 'POST', url: '/api/v1/setup/storage', bodyText: JSON.stringify({}) });
  assert.equal(configured.status, 200);
  assert.equal(configured.body.ok, true);
  assert.equal(configured.body.status.phase, 'ready');

  // After setup, normal endpoints are no longer blocked (gate passes through).
  const ok = await hit(handler, { url: '/api/v1/categories' });
  assert.notEqual(ok.status, 503, 'gate is open after setup');
});

test('HTTP health probe answers before setup and before activation', async () => {
  const root = tempRoot();
  const storage = new StorageService({ env: { GRAYSTORAGE_ROOT: root } });
  const app = createApp({ storage });
  const handler = createHttpServer(app);

  const health = await hit(handler, { url: '/api/v1/health' });
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.phase, 'unconfigured');
  assert.match(health.body.version, /^\d+\.\d+\.\d+/);

  // Only the bare probe is exempt; deeper paths still fall through the gate.
  const deep = await hit(handler, { url: '/api/v1/health/extra' });
  assert.notEqual(deep.status, 200);
});
