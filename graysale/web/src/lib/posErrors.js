import { fmtMoney } from './format';

// Plain-English versions of the codes the server throws at the till.
// Cashiers should never have to read "UNPAID: need 300 cents more".
const RULES = [
  [/^UNPAID: need (\d+) cents more/i, (m) => `Not enough paid — ${fmtMoney(Number(m[1]))} still due.`],
  [/^UNPAID\b/i, 'Not enough paid — take more money or take an item off.'],
  [/^INSUFFICIENT_STOCK:?\s*(.*)/i, (m) => (m[1] ? `Not enough stock for "${m[1]}".` : 'Not enough stock.')],
  [
    /^PRODUCT_INACTIVE:?\s*(.*)/i,
    (m) => (m[1] ? `"${m[1]}" is no longer for sale.` : 'That product is no longer for sale.'),
  ],
  [/^PRODUCT_NOT_FOUND:?\s*(.*)/i, (m) => (m[1] ? `No product matches "${m[1]}".` : 'Product not found.')],
  [/^QTY_MUST_BE_POSITIVE_INTEGER/i, 'Quantity must be a whole number of 1 or more.'],
  [/^PRICE_NEGATIVE/i, 'A price cannot be negative.'],
  [/^CREDIT_SALE_REQUIRES_CUSTOMER/i, 'A credit sale needs a customer — pick one first.'],
  [/^CREDIT_LIMIT_NOT_SET/i, 'This customer has no credit limit set. Ask the owner.'],
  [/^CREDIT_LIMIT_EXCEEDED/i, 'This would go over the customer’s credit limit.'],
  [/^PAYMENTS_REQUIRED/i, 'No payment was sent — try again.'],
  [
    /^INVALID_PAYMENT_METHOD:?\s*(.*)/i,
    (m) => (m[1] ? `Unknown payment method "${m[1]}".` : 'Unknown payment method.'),
  ],
  [
    /^SKU_EXISTS:?\s*(.*)/i,
    (m) => (m[1] ? `SKU "${m[1]}" is already used by another product.` : 'That SKU is already used.'),
  ],
  [
    /^BARCODE_EXISTS:?\s*(.*)/i,
    (m) =>
      m[1]
        ? `Barcode "${m[1]}" already belongs to another product.`
        : 'That barcode already belongs to another product.',
  ],
  [/^PRODUCT_NAME_REQUIRED/i, 'Enter a product name.'],
  [/^SKU_REQUIRED/i, 'Enter a SKU (product code).'],
  [/^NAME_REQUIRED/i, 'Enter a name.'],
  [/^PASSWORD_TOO_SHORT/i, 'Password must be at least 6 characters.'],
  [/^CURRENT_PASSWORD_REQUIRED/i, 'Enter your current password.'],
  [/^DUPLICATE_USERNAME:?\s*(.*)/i, (m) => (m[1] ? `Username "${m[1]}" is taken.` : 'That username is taken.')],
  [/^LAYAWAY_REQUIRES_CUSTOMER/i, 'A layby needs a customer — pick one first.'],
  [/^LAYAWAY_DEPOSITS_MUST_BE_CASH_LIKE/i, 'Layby deposits must be paid in cash.'],
  [/^PAYMENT_EXCEEDS_BALANCE/i, 'That is more than the balance owing.'],
  [/^ACTIVATION REQUIRED|^Activation required/i, 'This till is not activated yet.'],
];

export function friendlyPosError(message) {
  const msg = String(message ?? '').trim();
  if (!msg) return 'Something went wrong — try again.';
  for (const [re, out] of RULES) {
    const m = msg.match(re);
    if (m) return typeof out === 'function' ? out(m) : out;
  }
  return msg;
}
