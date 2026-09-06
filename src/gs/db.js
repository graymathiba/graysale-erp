import { DatabaseSync } from 'node:sqlite';
import { nextDoc, DOC_PREFIX } from '../db/counters.js';

// Shared helper additions on top of the main node:sqlite instance.

// nextDoc / DOC_PREFIX are the shared document-numbering helpers from
// src/db/counters.js (used by the main ERP too), re-exported for the gs side.

const db_ = (db) => {
  if (db instanceof DatabaseSync) return db;
  throw new TypeError('gs: expected a node:sqlite DatabaseSync instance');
};

// BEGIN immediately. Caller MUST end the session.
const begin = (db) => {
  db.exec('BEGIN');
  const session = {
    db,
    savepoint(name) {
      db.exec(`SAVEPOINT ${name}`);
      return {
        db,
        release: () => db.exec(`RELEASE ${name}`),
        rollback: () => db.exec(`ROLLBACK TO ${name}`),
      };
    },
    commit: () => db.exec('COMMIT'),
    rollback: () => db.exec('ROLLBACK'),
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
  };
  return session;
};

// Nested-transaction guard: track depth in-process (node:sqlite is fully
// synchronous) so service calls that themselves open a transaction can be
// composed inside another one via SQLite SAVEPOINTs.
let txDepth = 0;
let txSeq = 0;

// Run fn within a single transaction (savepoint-safe). Rolls back on throw.
const tx = (db, fn) => {
  if (txDepth > 0) {
    const name = `sp_${++txSeq}`;
    db.exec(`SAVEPOINT ${name}`);
    txDepth++;
    try {
      const result = fn(db);
      db.exec(`RELEASE ${name}`);
      txDepth--;
      return result;
    } catch (err) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      txDepth--;
      throw err;
    }
  }
  db.exec('BEGIN');
  txDepth++;
  try {
    const result = fn(db);
    db.exec('COMMIT');
    txDepth--;
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    txDepth--;
    throw err;
  }
};

export { DatabaseSync, db_, begin, tx, nextDoc, DOC_PREFIX };