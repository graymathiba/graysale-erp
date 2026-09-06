import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { snapshotDatabase, backupToLocalFolder, rotateBackups } from '../src/backup/backup.js';

const SRC_BACKUP_DIR = fileURLToPath(new URL('../src/backups', import.meta.url));

function makeSourceDb(name) {
  const dbPath = join(SRC_BACKUP_DIR, name);
  if (existsSync(dbPath)) rmSync(dbPath);
  const store = new Store(dbPath);
  store.db.exec("INSERT INTO products (sku, name, category, price_cents) VALUES ('T9','Test','X',100)");
  store.db.close();
  return dbPath;
}

test('snapshotDatabase produces a consistent snapshot file', () => {
  const dbPath = makeSourceDb('test-src.db');
  const out = snapshotDatabase(dbPath);
  assert.ok(existsSync(out));
});

test('repeated local backups succeed (no output-file collision)', async () => {
  const dbPath = makeSourceDb('test-src2.db');
  const a = await backupToLocalFolder({ dbPath, backupDir: SRC_BACKUP_DIR });
  const b = await backupToLocalFolder({ dbPath, backupDir: SRC_BACKUP_DIR });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(typeof a.size, 'number');
  assert.notEqual(a.dest, b.dest);
});

test('rotateBackups keeps only N most recent files', () => {
  const rotateDir = join(SRC_BACKUP_DIR, 'rotate-test');
  if (!existsSync(rotateDir)) mkdirSync(rotateDir, { recursive: true });

  // Create 5 fake backup files
  const files = [];
  for (let i = 0; i < 5; i++) {
    const fname = `supermarket-2026-08-0${i + 1}T00-00-00-000Z.db`;
    const fpath = join(rotateDir, fname);
    writeFileSync(fpath, `backup-${i}`);
    files.push(fpath);
  }

  // Keep only 3, should delete 2 oldest
  const deleted = rotateBackups({ backupDir: rotateDir, keepCount: 3 });
  assert.equal(deleted.length, 2);

  // Verify remaining files
  const remaining = files.filter(f => existsSync(f));
  assert.equal(remaining.length, 3);

  // Cleanup
  for (const f of files) {
    if (existsSync(f)) rmSync(f);
  }
  rmSync(rotateDir, { recursive: true, force: true });
});

test('rotateBackups handles empty directory gracefully', () => {
  const emptyDir = join(SRC_BACKUP_DIR, 'empty-test');
  if (!existsSync(emptyDir)) mkdirSync(emptyDir, { recursive: true });
  const deleted = rotateBackups({ backupDir: emptyDir, keepCount: 5 });
  assert.equal(deleted.length, 0);
  rmSync(emptyDir, { recursive: true, force: true });
});

test('rotateBackups ignores non-backup files', () => {
  const mixedDir = join(SRC_BACKUP_DIR, 'mixed-test');
  if (!existsSync(mixedDir)) mkdirSync(mixedDir, { recursive: true });

  // Create backup files and a non-backup file
  writeFileSync(join(mixedDir, 'supermarket-2026-08-01.db'), 'backup1');
  writeFileSync(join(mixedDir, 'supermarket-2026-08-02.db'), 'backup2');
  writeFileSync(join(mixedDir, 'snapshot.db'), 'should be ignored');
  writeFileSync(join(mixedDir, 'readme.txt'), 'should be ignored');

  const deleted = rotateBackups({ backupDir: mixedDir, keepCount: 1 });
  assert.equal(deleted.length, 1);

  // snapshot.db and readme.txt should still exist
  assert.ok(existsSync(join(mixedDir, 'snapshot.db')));
  assert.ok(existsSync(join(mixedDir, 'readme.txt')));

  // Cleanup
  rmSync(mixedDir, { recursive: true, force: true });
});

test('rotateBackups with keepCount 0 deletes all backup files', () => {
  const delDir = join(SRC_BACKUP_DIR, 'del-test');
  if (!existsSync(delDir)) mkdirSync(delDir, { recursive: true });

  writeFileSync(join(delDir, 'supermarket-2026-08-01.db'), 'b1');
  writeFileSync(join(delDir, 'supermarket-2026-08-02.db'), 'b2');

  const deleted = rotateBackups({ backupDir: delDir, keepCount: 0 });
  assert.equal(deleted.length, 2);
  assert.ok(!existsSync(join(delDir, 'supermarket-2026-08-01.db')));
  assert.ok(!existsSync(join(delDir, 'supermarket-2026-08-02.db')));

  rmSync(delDir, { recursive: true, force: true });
});

test.after(() => {
  for (const f of ['test-src.db', 'test-src2.db', 'snapshot.db']) {
    const p = join(SRC_BACKUP_DIR, f);
    if (existsSync(p)) rmSync(p);
  }
});
