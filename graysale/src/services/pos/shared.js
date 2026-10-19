// Shared constants and helpers used across the PosService method clusters
// (core, offline sync, EcoCash, layaway, quotes). Kept in one module so the
// mixin files and the core class stay in sync.

export const METHODS = new Set(['CASH', 'CARD', 'MOBILE', 'ECOCASH', 'BANK', 'CREDIT']);

// Offline tills send free-form payment labels; normalise the common ones.
export const SYNC_METHOD_ALIASES = {
  CASH: 'CASH',
  CASH_CASH: 'CASH',
  USD: 'CASH',
  ECOCASH_CASH: 'CASH',
  CARD: 'CARD',
  CREDIT_CARD: 'CARD',
  VISA: 'CARD',
  MASTERCARD: 'CARD',
  MOBILE: 'MOBILE',
  MOBILE_MONEY: 'MOBILE',
  MOMO: 'MOBILE',
  ECOCASH: 'ECOCASH',
  ECO_CASH: 'ECOCASH',
  BANK: 'BANK',
  TRANSFER: 'BANK',
};

// Upper bound on one sync request so a huge replay cannot pin the single
// synchronous SQLite handle for the whole batch.
export const SYNC_MAX_BATCH = 500;

export const cashTarget = (method) => (method === 'CASH' ? '1000' : '1010'); // CARD/MOBILE/BANK -> Bank
