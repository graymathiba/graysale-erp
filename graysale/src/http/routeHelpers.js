// Helpers shared by the per-domain route modules in this folder.

import { dirname, join } from 'node:path';
import { config } from '../config.js';

export function NumID(v, dflt) {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : dflt;
}

export function dbSetting(services, key) {
  return services.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '';
}

export function setDefaultPrinter(services, id) {
  services.db.prepare('UPDATE printers SET is_default = 0').run();
  services.db.prepare('UPDATE printers SET is_default = 1 WHERE id = ?').run(Number(id));
}

// Snapshots live next to the data file unless BACKUP_DIR overrides it.
// Resolved per call so a storage relocation is followed automatically.
export function backupDir(services) {
  const dbPath = services.storage?.attachedPath || services.storage?.dbPath || config.dbPath;
  return config.backupDir || join(dirname(dbPath), 'backups');
}
