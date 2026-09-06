// Money helpers — everything is integer cents. No floats in business math.

export const ZERO = 0;

export const toCents = (amount) => {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
};

export const fromCents = (cents) => Number(cents || 0) / 100;

export const formatCents = (cents, symbol = '') => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents || 0);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${symbol}${sign}${dollars.toLocaleString('en-US')}.${String(rem).padStart(2, '0')}`;
};

export const add = (...cents) => cents.reduce((a, b) => a + (b ?? 0), 0);
export const sum = (arr, f) => arr.reduce((a, it) => a + (f(it) ?? 0), 0);

// money of an amount string with a rate in basis points (e.g. 1500 = 15%)
export const taxOn = (amountCents, rateBps) =>
  Math.round(((amountCents || 0) * (rateBps || 0)) / 10000);

// apply percentage discount on integer cents, half-up
export const percentOf = (cents, percent) =>
  Math.round(((cents || 0) * (percent || 0)) / 100);