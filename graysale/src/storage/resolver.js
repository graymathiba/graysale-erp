// Where does GraySale keep its data? Resolution order (first hit wins):
//   GRAYSTORAGE_DESCRIPTOR  → explicit path to the storage.json descriptor
//   GRAYSTORAGE_ROOT        → explicit data folder
//   <default data dir>      → the app's own data/ folder (legacy default)

import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_PATH } from '../db/database.js';

export function getStorageRoot(env = process.env) {
  if (env.GRAYSTORAGE_DESCRIPTOR) return dirname(resolve(env.GRAYSTORAGE_DESCRIPTOR));
  if (env.GRAYSTORAGE_ROOT) return resolve(env.GRAYSTORAGE_ROOT);
  return dirname(DEFAULT_PATH);
}

export function defaultDbPath(storageRoot = getStorageRoot()) {
  return join(storageRoot, 'graysale.db');
}

export function resolveStorageContext({ dbPath = null, env = process.env } = {}) {
  const root = resolve(dbPath ? dirname(dbPath) : getStorageRoot(env));
  const resolvedDbPath = dbPath ? (isAbsolute(dbPath) ? dbPath : join(root, dbPath)) : defaultDbPath(root);
  return { storageRoot: root, dbPath: resolvedDbPath };
}

export default { getStorageRoot, defaultDbPath, resolveStorageContext };
