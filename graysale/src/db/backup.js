// Database backups via SQLite VACUUM INTO: produces a consistent snapshot of
// the live database (including WAL contents) without blocking writers for the
// whole copy. Snapshots land in a rotating folder — newest N are kept.
//
// No runtime dependencies: plain node:fs + the open sqlite handle.

import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const SNAPSHOT_RE = /^graysale-\d{4}-\d{2}-\d{2}T[\d-]+Z(?:-.+)?\.db$/;

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-'); // 2026-10-06T14-30-00-000Z
}

export function backupDatabase(db, { dir, keep = 7, label = '' } = {}) {
  if (!dir) throw new Error('backup dir not configured');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `graysale-${stamp()}${label ? `-${label}` : ''}.db`);
  // VACUUM INTO takes a path literal — quote it for SQL safety.
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const bytes = statSync(file).size;
  const removed = rotateBackups(dir, keep);
  return { file, bytes, removed };
}

// Keeps the `keep` newest snapshots; returns how many were deleted.
export function rotateBackups(dir, keep) {
  let files;
  try {
    files = readdirSync(dir)
      .filter((f) => SNAPSHOT_RE.test(f))
      .sort(); // ISO stamps sort chronologically
  } catch {
    return 0;
  }
  let removed = 0;
  while (files.length > keep) {
    try {
      unlinkSync(join(dir, files.shift()));
      removed++;
    } catch {
      break; // file vanished mid-rotate — good enough
    }
  }
  return removed;
}

export function listBackups(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => SNAPSHOT_RE.test(f))
      .sort()
      .reverse()
      .map((f) => {
        try {
          const { size, mtimeMs } = statSync(join(dir, f));
          return { file: f, bytes: size, createdAt: new Date(mtimeMs).toISOString() };
        } catch {
          return null; // vanished between readdir and stat
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export default { backupDatabase, rotateBackups, listBackups };
