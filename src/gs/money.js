const toCents = (x) => Math.round(Number(x) * 100);

const fromCents = (x) => Math.round(Number(x) || 0) / 100;

const formatCents = (x) => `$${Math.abs(Math.round(Number(x) || 0) / 100).toFixed(2)}`;

const taxOn = (amountCents, rateNumerator, rateDenominator = 10000) =>
  Math.floor(amountCents * rateNumerator / rateDenominator);

const percentOf = (amountCents, percent) =>
  Math.round(amountCents * percent / 100);

export {
  toCents,
  fromCents,
  formatCents,
  taxOn,
  percentOf,
};