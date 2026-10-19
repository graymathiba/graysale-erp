import { randomBytes } from 'node:crypto';

// Business document numbering helpers.
export const pad = (n, w = 5) => String(n).padStart(w, '0');

export const nextDocNo = (prefix, table, db, col = 'doc_no') => {
  const row = db
    .prepare(`SELECT ${col} AS no FROM ${table} WHERE ${col} LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(`${prefix}%`);
  const n = row ? (parseInt(row.no.slice(prefix.length), 10) || 0) + 1 : 1;
  return `${prefix}-${pad(n)}`;
};

export const token = (bytes = 24) => randomBytes(bytes).toString('hex');

export const nowIso = () => new Date().toISOString();

// Local business date string YYYY-MM-DD in the machine's timezone.
export const localDate = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const todayLocal = () => localDate(new Date());

// 'YYYY-MM-DD HH:MM:SS' in the machine's timezone — the same shape SQLite
// prints for datetime('now','localtime'), so business timestamps compare
// cleanly with column defaults and with each other.
export const localStamp = (d = new Date()) =>
  `${localDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;

export const nowLocal = () => localStamp();
