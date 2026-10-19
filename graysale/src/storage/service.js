// Storage service: resolves where data lives, detects machine changes, and
// reports what is actually inside the data folder.
//
// State machine (unless `managed`):
//   unconfigured     no storage.json descriptor → first-run setup
//   new_environment  descriptor exists but this machine is not its recorded
//                    owner → the data may have been moved (USB) → confirm
//   ready            this machine owns the descriptor → normal operation

import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { machineFingerprint, machineHostname, machineLabel } from './machine.js';
import { loadInstall, saveInstall, recordEnvironment, environmentMatches, descriptorPath } from './install.js';
import { defaultDbPath, getStorageRoot } from './resolver.js';

const TENANT_TABLES = [
  'users',
  'settings',
  'product_categories',
  'products',
  'customers',
  'suppliers',
  'orders',
  'ar_invoices',
  'ap_bills',
  'payments',
  'company_settings',
];

export class StorageService {
  // managed = the caller explicitly chose a db path (tests, direct openDb);
  // no descriptor ceremony required, always ready.
  constructor({ dbPath = null, env = process.env, managed = false } = {}) {
    this.env = env;
    this.managed = Boolean(managed);
    this.machine = {
      machineId: machineFingerprint(),
      hostname: machineHostname(),
      label: machineLabel(),
    };
    if (this.managed) {
      this.storageRoot = resolve(dbPath ? dirname(resolve(dbPath)) : getStorageRoot(env));
      this.dbPath = dbPath ? resolve(dbPath) : defaultDbPath(this.storageRoot);
      this.install = null;
      this.phase = 'ready';
    } else {
      this.storageRoot = resolve(getStorageRoot(env));
      this.dbPath = null; // resolved in _reconcile()
      this.install = null;
      this.phase = 'unconfigured';
      this._reconcile();
    }
    this.db = null;
  }

  // Called by createApp once the SQLite handle is open.
  setDb(db) {
    this.db = db;
    return this;
  }

  _reconcile() {
    this.install = loadInstall(this.storageRoot);
    if (!this.install) {
      this.phase = 'unconfigured';
      this.dbPath = join(this.storageRoot, 'graysale.db');
      return;
    }
    const fname = String(this.install.dbFile || 'graysale.db');
    this.dbPath = join(this.storageRoot, fname);
    this.phase = environmentMatches(this.install, this.machine.machineId) ? 'ready' : 'new_environment';
  }

  get ready() {
    return this.phase === 'ready';
  }

  // ----- what the frontend needs at boot -----
  status() {
    const storage = {
      root: this.storageRoot,
      dbFile: this.dbPath,
      dbExists: existsSync(this.dbPath),
      descriptor: this.install ? descriptorPath(this.storageRoot) : null,
      kind: this.install ? this.install.storageKind : null,
      byteSize: existsSync(this.dbPath) ? statSync(this.dbPath).size : 0,
    };
    return {
      phase: this.phase,
      managed: this.managed,
      machine: this.machine,
      storage,
      installedBy: this.install ? this.install.installedMachine : null,
      environment: this.install ? this.install.environment : null,
    };
  }

  // ----- what is actually in the data folder -----
  fileView() {
    let files = [];
    let dbTables = [];
    let tenants = [];
    let dbSize = 0;
    if (existsSync(this.storageRoot)) {
      files = readdirSync(this.storageRoot)
        .map((name) => {
          const fp = join(this.storageRoot, name);
          try {
            const s = statSync(fp);
            return { name, size: s.isDirectory() ? null : s.size, dir: s.isDirectory() };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    }
    if (this.db && existsSync(this.dbPath)) {
      try {
        dbSize = statSync(this.dbPath).size;
      } catch {
        /* */
      }
      try {
        const tables = this.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all();
        dbTables = tables
          .map((t) => {
            const row = this.db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get();
            return { name: t.name, rows: row ? Number(row.c) : 0 };
          })
          .sort((a, b) => b.rows - a.rows);
      } catch {
        /* schema race */
      }
      try {
        const hasTenants = !!this.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'")
          .get();
        if (hasTenants) {
          tenants = this.db
            .prepare('SELECT id, company_name, status FROM tenants ORDER BY created_at ASC')
            .all()
            .map((t) => {
              const counts = {};
              for (const table of TENANT_TABLES) {
                try {
                  const r = this.db.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE tenant_id = ?`).get(t.id);
                  counts[table] = r ? Number(r.c) : 0;
                } catch {
                  counts[table] = 0;
                }
              }
              return { tenant_id: t.id, company_name: t.company_name, status: t.status, counts };
            });
        }
      } catch {
        /* */
      }
    }
    return { root: this.storageRoot, dbPath: this.dbPath, dbSize, files, tables: dbTables, tenants };
  }

  // Where the current install lives — stamped onto tenants at onboarding.
  tenantDescriptor() {
    return {
      kind: this.install ? this.install.storageKind : this.managed ? 'local' : null,
      path: this.storageRoot,
      db: basename(this.dbPath),
      machineId: this.machine.machineId,
    };
  }

  // ----- setup -----
  // `root` omitted = keep the current folder (first-run default, or a moved
  // folder acknowledged in place). `root` set = adopt/relocate the data dir.
  setup({ root = null, kind = 'local' } = {}) {
    const next = { ok: true, reload: false, tracked: false, adopted: false };
    if (root && String(root).trim()) {
      const target = resolve(String(root).trim());
      return this._setRoot(target, kind, next);
    }
    if (!this.install) {
      this.install = saveInstall(this.storageRoot, { storageKind: kind }, this.machine.machineId);
      this.install = recordEnvironment(this.storageRoot, this.install, this.machine.machineId);
      next.tracked = true;
    } else {
      this.install = recordEnvironment(this.storageRoot, this.install, this.machine.machineId);
      next.tracked = true;
    }
    this.phase = 'ready';
    return { ...next, status: this.status() };
  }

  // Explicit "yes, use this (possibly foreign) data" — re-home the current
  // folder on this machine without moving any file.
  adopt() {
    if (!this.install) {
      this.install = saveInstall(this.storageRoot, {}, this.machine.machineId);
    }
    this.install = recordEnvironment(this.storageRoot, this.install, this.machine.machineId);
    this.phase = 'ready';
    return { ok: true, reload: false, adopted: this.phase === 'ready', status: this.status() };
  }

  _setRoot(target, kind, next) {
    const targetDescriptor = loadInstall(target);
    if (targetDescriptor) {
      // The chosen folder is itself a GraySale install — adopt its data.
      this.storageRoot = target;
      this.install = recordEnvironment(target, targetDescriptor, this.machine.machineId);
      this.dbPath = join(target, String(targetDescriptor.dbFile || 'graysale.db'));
      this.phase = 'ready';
      next.adopted = true;
      next.reload = this._dbMoved();
      return { ...next, status: this.status() };
    }
    mkdirSync(target, { recursive: true });
    const targetDb = join(target, 'graysale.db');
    let copied = false;
    if (existsSync(this.dbPath) && resolve(this.dbPath) !== resolve(targetDb)) {
      this._copyDb(this.dbPath, targetDb);
      copied = true;
    }
    this.install = saveInstall(target, { storageKind: kind, dbFile: 'graysale.db' }, this.machine.machineId);
    this.install = recordEnvironment(target, this.install, this.machine.machineId);
    this.storageRoot = target;
    this.dbPath = targetDb;
    this.phase = 'ready';
    next.tracked = true;
    next.copied = copied;
    next.reload = this._dbMoved();
    return { ...next, status: this.status() };
  }

  _copyDb(src, dst) {
    try {
      copyFileSync(src, dst);
    } catch {
      /* non-fatal */
    }
    for (const ext of ['-wal', '-shm']) {
      const wp = src + ext;
      if (existsSync(wp)) {
        try {
          copyFileSync(wp, dst + ext);
        } catch {
          /* */
        }
      }
    }
  }

  // True when the attached DB handle no longer matches the resolved db path,
  // so the HTTP server must reopen the app before serving more requests.
  _dbMoved() {
    if (!this.db) return false;
    const attached = this.attachedPath;
    return !!attached && resolve(attached) !== resolve(this.dbPath);
  }

  emitRelocate() {
    if (this._relocateCb) this._relocateCb(this.dbPath);
  }

  onRelocate(cb) {
    this._relocateCb = cb;
  }
}

export default StorageService;
