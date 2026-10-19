import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './schema.js';
import { config } from '../config.js';

export const DEFAULT_PATH = config.dbPath || fileURLToPath(new URL('../data/graysale.db', import.meta.url));

export function openDb(path = DEFAULT_PATH) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

export function initDb(db) {
  runMigrations(db);
  db.exec('CREATE TABLE IF NOT EXISTS counters (type TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);');
  return db;
}

// Nesting-safe transaction helper using SQLite savepoints. A top-level call
// opens a real transaction; nested calls open savepoints that roll back to
// their own savepoint on failure so an inner failure doesn't abort the outer
// transaction unless it propagates.
export function tx(db, fn) {
  if (db._inTx === undefined) db._inTx = 0;
  const outer = db._inTx === 0;
  db._inTx++;
  const sp = !outer ? `sp_${db._inTx}` : null;
  db.exec(sp ? `SAVEPOINT ${sp}` : 'BEGIN');
  try {
    const out = fn();
    db.exec(sp ? `RELEASE ${sp}` : 'COMMIT');
    db._inTx--;
    return out;
  } catch (e) {
    db.exec(sp ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
    db._inTx--;
    throw e;
  }
}

// Sequential per-type document numbering (SALE-00001, INV-00002, ...).
// Increment is a single atomic statement so concurrent callers (webhook
// settlement, multi-connection WAL) can never compute the same number twice.
export function nextDoc(db, prefix) {
  const row = db
    .prepare(
      `
    INSERT INTO counters (type, value) VALUES (?, 1)
    ON CONFLICT(type) DO UPDATE SET value = value + 1
    RETURNING value
  `,
    )
    .get(prefix);
  const n = row ? Number(row.value) : 1;
  return `${prefix}-${String(n).padStart(5, '0')}`;
}

export default { openDb, initDb, tx, nextDoc };
