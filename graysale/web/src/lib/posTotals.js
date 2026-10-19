// Tax-aware cart totals for the Classic Desktop POS.
//
// Mirrors buildLine()/_totals() in graysale/src/services/pos.js so the figures
// on the cashier screen are exactly what POST /pos/sell charges.
// All money is integer cents; rates are basis points (1500 = 15%).

export const taxOn = (amountCents, rateBps) => Math.round(((amountCents || 0) * (rateBps || 0)) / 10000);

function rateBpsFor(line, productMap) {
  if (line.product?.tax_rate_bps != null) return line.product.tax_rate_bps;
  if (line.taxRateBps != null) return line.taxRateBps;
  return productMap?.get(line.productId)?.tax_rate_bps ?? 0;
}

/**
 * @param {Array}  lines    cart lines ({ productId, unitCents, qty, product?, lineDisc? })
 * @param {number} discPct  order-level discount percent (0-100)
 * @param {Map}    [productMap] product lookup for tax rates when the line carries no product
 * @returns {{ lines, subtotal, discount, tax, total, grandQty }}
 *          `lines` gains gross / disc / tax / lineTotal per row.
 */
export function computeTotals(lines = [], discPct = 0, productMap = null) {
  const rows = (lines || []).map((l) => {
    const gross = Math.round((l.unitCents || 0) * (l.qty || 0));
    const lineDisc = Math.round(l.lineDisc || 0);
    const rateBps = rateBpsFor(l, productMap);
    return { line: l, gross, lineDisc, rateBps, baseTax: taxOn(gross - lineDisc, rateBps) };
  });

  const subtotal = rows.reduce((s, r) => s + r.gross, 0);
  let discount = rows.reduce((s, r) => s + r.lineDisc, 0);
  const pct = Math.max(0, Math.min(100, Number(discPct) || 0));
  if (pct) discount += Math.round(((subtotal - discount) * pct) / 100);
  const net = subtotal - discount;
  // An order-level discount shrinks the taxable base: recompute every line's
  // tax on its discounted share, exactly like the server does.
  const recompute = discount !== 0 && net !== subtotal;

  const orderShares = rows.map((r) => {
    if (!recompute || r.gross === 0) return 0;
    const portion = subtotal ? Math.round((r.gross * 1e6) / subtotal) : 0;
    return Math.round((discount * portion) / 1e6);
  });

  const out = rows.map((r, i) => {
    const orderDisc = orderShares[i];
    const disc = r.lineDisc + orderDisc;
    const lineNet = r.gross - disc;
    const tax = recompute ? taxOn(lineNet, r.rateBps) : r.baseTax;
    return { ...r.line, gross: r.gross, disc, tax, lineTotal: lineNet + tax };
  });

  const tax = out.reduce((s, l) => s + l.tax, 0);
  return {
    lines: out,
    subtotal,
    discount,
    tax,
    total: net + tax,
    grandQty: rows.reduce((s, r) => s + (r.line.qty || 0), 0),
  };
}
