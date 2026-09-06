// Cloud backup for the local SQLite database.
//
// SQLite is a single file, so backing it up is simply copying that file to
// cloud storage. This module supports two approaches with zero external deps:
//
//   1. Local folder target (destination like D:\backups or \\server\share)
//      - Schedules automatic periodic copies (WAL-safe using sqlite backup API)
//   2. AWS S3 / Azure Blob (optional, if aws cli / az cli is installed)
//      - Shells out to the respective CLI
//
// Because only ONE process should write WAL checkpoints at a time, we use the
// SQLite ONLINE BACKUP API (via a tiny VACUUM INTO) which produces a
// consistent snapshot even while the app is running.

import { createDb } from '../db/database.js';
import { execSync } from 'node:child_process';
import { mkdirSync, existsSync, copyFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const DEFAULT_DB = process.env.DB_PATH || fileURLToPath(new URL('../data/supermarket.db', import.meta.url));
const DEFAULT_BACKUP_DIR = process.env.BACKUP_DIR || fileURLToPath(new URL('../backups', import.meta.url));

// Produce a consistent snapshot file (WAL-safe) via VACUUM INTO.
export function snapshotDatabase(dbPath = DEFAULT_DB) {
  const out = join(DEFAULT_BACKUP_DIR, 'snapshot.db');
  if (!existsSync(DEFAULT_BACKUP_DIR)) mkdirSync(DEFAULT_BACKUP_DIR, { recursive: true });
  if (existsSync(out)) rmSync(out);
  const db = createDb(dbPath);
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  db.close();
  return out;
}

export async function backupToLocalFolder({ dbPath = DEFAULT_DB, backupDir = DEFAULT_BACKUP_DIR, keepCount = 10 } = {}) {
  const snap = snapshotDatabase(dbPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
  const dest = join(backupDir, `supermarket-${stamp}.db`);
  copyFileSync(snap, dest);
  const size = (await import('node:fs/promises')).stat(dest).then(s => s.size);
  rotateBackups({ backupDir, keepCount });
  return { ok: true, dest, size: await size };
}

// Upload snapshot to S3 via aws cli (if installed).
export function backupToS3({ bucket, prefix = 'backups', dbPath = DEFAULT_DB }) {
  const snap = snapshotDatabase(dbPath);
  const key = join(prefix, `supermarket-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  execSync(`aws s3 cp "${snap}" "s3://${bucket}/${key}"`, { stdio: 'inherit' });
  return { ok: true, key };
}

// Upload snapshot to Azure Blob via az cli (if installed). Container must exist.
export function backupToAzureBlob({ storageAccount, container, dbPath = DEFAULT_DB }) {
  const snap = snapshotDatabase(dbPath);
  const blob = `supermarket-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
  execSync(
    `az storage blob upload --account-name ${storageAccount} --container-name ${container} --file "${snap}" --name "${blob}"`,
    { stdio: 'inherit' }
  );
  return { ok: true, blob };
}

// Convenience: run a periodic backup loop.
export function scheduleBackup(intervalMs, fn) {
  return setInterval(async () => {
    try { await fn(); } catch (e) { console.error('Backup failed:', e.message); }
  }, intervalMs);
}

export function rotateBackups({ backupDir = DEFAULT_BACKUP_DIR, keepCount = 10 } = {}) {
  if (!existsSync(backupDir)) return [];
  const entries = readdirSync(backupDir)
    .filter(f => f.startsWith('supermarket-') && f.endsWith('.db') && f !== 'snapshot.db')
    .map(f => ({ name: f, time: statSync(join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  const deleted = [];
  for (let i = keepCount; i < entries.length; i++) {
    const target = join(backupDir, entries[i].name);
    try { rmSync(target); deleted.push(entries[i].name); } catch (_) {}
  }
  return deleted;
}

export function autoBackup({ store, intervalMs = 4 * 60 * 60 * 1000, backupDir = DEFAULT_BACKUP_DIR, keepCount = 10 } = {}) {
  return setInterval(async () => {
    try {
      await backupToLocalFolder({ dbPath: store?.db?.name, backupDir, keepCount });
    } catch (e) {
      console.error('Auto-backup failed:', e.message);
    }
  }, intervalMs);
}
