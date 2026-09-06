// Shared document numbering through the counters table.
// Both the main ERP (pos.js) and the retail port (src/gs) post journal
// entries into the same journal_entries table, so they must draw numbers
// from the same source to avoid UNIQUE(entry_no) collisions.

const DOC_PREFIX = {
  SALE: 'SALE',
  REFUND: 'RFD',
  LAYAWAY: 'LA',
  QUOTE: 'QT',
  ORDER: 'PO',
  PO: 'PO',
  INV: 'INV',
  BILL: 'BILL',
  CN: 'CN',
  GR: 'GR',
  PYMT: 'PYMT',
  JE: 'JE',
  SHIFT: 'SHIFT',
};

// Document numbering through the shared counters table.
// Falls back to legacy Max+1 style if the counters table is unavailable.
function nextDoc(db, type) {
  const key = DOC_PREFIX[type] || String(type).toUpperCase();
  let row;
  try {
    row = db.prepare(
      `INSERT INTO counters (type, value) VALUES (?, 1)
       ON CONFLICT(type) DO UPDATE SET value = value + 1
       RETURNING value`
    ).get(key);
  } catch {
    row = null;
  }
  if (row) {
    return `${key}-${String(Number(row.value)).padStart(6, '0')}`;
  }
  const row2 = db.prepare('SELECT COUNT(*) AS c FROM gs_orders').get();
  const count = Number(row2?.c ?? 0) + 1;
  return `${key}-${String(count).padStart(6, '0')}`;
}

function resetCounter(db, type, value) {
  const key = DOC_PREFIX[type] || String(type).toUpperCase();
  db.prepare(
    'INSERT INTO counters (type, value) VALUES (?, ?) ON CONFLICT(type) DO UPDATE SET value = ?'
  ).run(key, value, value);
  return value;
}

export { nextDoc, DOC_PREFIX, resetCounter };