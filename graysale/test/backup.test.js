import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDatabase, listBackups, rotateBackups } from '../src/db/backup.js';
import { openDb } from '../src/db/database.js';
import { makeApp, seedCatalog } from './helpers.js';

test('backupDatabase snapshots live data and the copy opens cleanly', () => {
  const app = makeApp();
  seedCatalog(app);
  const dir = mkdtempSync(join(tmpdir(), 'gs-backup-'));

  const r = backupDatabase(app.db, { dir, keep: 5 });

  assert.ok(existsSync(r.file));
  assert.ok(r.bytes > 0);
  assert.equal(r.removed, 0);
  assert.match(r.file, /graysale-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/);

  // The snapshot is a real database with the seeded catalog in it.
  const snap = openDb(r.file);
  try {
    assert.equal(snap.prepare('SELECT count(*) AS n FROM products').get().n, 2);
    assert.equal(snap.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    snap.close();
  }
  assert.equal(listBackups(dir).length, 1);
});

test('rotation keeps only the newest N snapshots and ignores unrelated files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gs-rotate-'));
  for (const d of ['2026-10-04T10-00-00-000Z', '2026-10-05T10-00-00-000Z', '2026-10-06T10-00-00-000Z']) {
    writeFileSync(join(dir, `graysale-${d}.db`), 'x');
  }
  writeFileSync(join(dir, 'notes.db'), 'x'); // never touched — not a snapshot name
  writeFileSync(join(dir, 'graysale-not-a-date.db'), 'x'); // malformed stamp — ignored

  const removed = rotateBackups(dir, 2);

  assert.equal(removed, 1);
  const left = readdirSync(dir).sort();
  assert.deepEqual(
    left,
    [
      'graysale-2026-10-05T10-00-00-000Z.db',
      'graysale-2026-10-06T10-00-00-000Z.db',
      'graysale-not-a-date.db',
      'notes.db',
    ].sort(),
  );
});

test('keep option prunes older real snapshots', async () => {
  const app = makeApp();
  const dir = mkdtempSync(join(tmpdir(), 'gs-keep-'));

  const first = backupDatabase(app.db, { dir, keep: 1 });
  await new Promise((r) => setTimeout(r, 5)); // distinct filename (ms stamp)
  const second = backupDatabase(app.db, { dir, keep: 1 });

  assert.ok(existsSync(second.file));
  assert.equal(first.removed, 0);
  assert.equal(second.removed, 1);
  assert.ok(!existsSync(first.file));
  assert.equal(listBackups(dir).length, 1);
});

test('listBackups returns newest first with sizes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gs-list-'));
  writeFileSync(join(dir, 'graysale-2026-10-05T10-00-00-000Z.db'), 'aa');
  writeFileSync(join(dir, 'graysale-2026-10-06T10-00-00-000Z.db'), 'aaaa');

  const list = listBackups(dir);
  assert.equal(list.length, 2);
  assert.match(list[0].file, /2026-10-06/);
  assert.equal(list[0].bytes, 4);
  assert.ok(list[0].createdAt);
});
