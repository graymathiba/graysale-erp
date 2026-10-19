import { describe, test, expect } from 'vitest';
import { computeTotals, taxOn } from './posTotals';

const line = (over = {}) => ({
  productId: 1,
  name: 'Item',
  unitCents: 1500,
  qty: 1,
  product: { tax_rate_bps: 1500 },
  ...over,
});

describe('taxOn', () => {
  test('rounds to the nearest cent', () => {
    expect(taxOn(999, 1500)).toBe(150); // 149.85 -> 150
    expect(taxOn(1000, 1500)).toBe(150);
    expect(taxOn(0, 1500)).toBe(0);
    expect(taxOn(1000, 0)).toBe(0);
  });
});

describe('computeTotals', () => {
  test('empty cart is all zeros', () => {
    expect(computeTotals([], 0)).toEqual({ lines: [], subtotal: 0, discount: 0, tax: 0, total: 0, grandQty: 0 });
  });

  test('no discount: tax rides on the gross', () => {
    const t = computeTotals([line({ qty: 2 })], 0);
    expect(t.subtotal).toBe(3000);
    expect(t.discount).toBe(0);
    expect(t.tax).toBe(450); // 15% of 3000
    expect(t.total).toBe(3450);
    expect(t.grandQty).toBe(2);
    expect(t.lines[0]).toMatchObject({ gross: 3000, disc: 0, tax: 450, lineTotal: 3450 });
  });

  test('order discount shrinks the taxable base', () => {
    const t = computeTotals([line({ qty: 2 })], 10);
    expect(t.discount).toBe(300);
    expect(t.subtotal - t.discount).toBe(2700);
    expect(t.tax).toBe(405); // 15% of 2700
    expect(t.total).toBe(3105);
    expect(t.lines[0]).toMatchObject({ disc: 300, tax: 405, lineTotal: 3105 });
  });

  test('order discount splits across lines by gross share (server portion math)', () => {
    // A: 1 x $10.00 @15%, B: 3 x $2.00 @0% — subtotal $16.00, 10% off
    const a = { productId: 1, name: 'A', unitCents: 1000, qty: 1, product: { tax_rate_bps: 1500 } };
    const b = { productId: 2, name: 'B', unitCents: 200, qty: 3, product: { tax_rate_bps: 0 } };
    const t = computeTotals([a, b], 10);

    expect(t.subtotal).toBe(1600);
    expect(t.discount).toBe(160); // 625000/1e6 -> $10.00 share = 100c, 375000/1e6 -> $6.00 share = 60c
    expect(t.lines[0].disc).toBe(100);
    expect(t.lines[1].disc).toBe(60);
    expect(t.lines[0].tax).toBe(135); // 15% of (1000 - 100)
    expect(t.lines[1].tax).toBe(0);
    expect(t.tax).toBe(135);
    expect(t.total).toBe(1440 + 135);
    expect(t.lines[0].lineTotal + t.lines[1].lineTotal).toBe(t.total);
  });

  test('tax rate falls back to the product map when the line carries no product', () => {
    const map = new Map([[9, { tax_rate_bps: 1500 }]]);
    const t = computeTotals([{ productId: 9, unitCents: 1000, qty: 1 }], 0, map);
    expect(t.tax).toBe(150);
    expect(t.total).toBe(1150);
  });

  test('line-level discount mirrors the server base reduction', () => {
    // The server recomputes tax on gross - lineDiscount - share(discount); with
    // only a line discount that reduces the base twice. The client mirrors it
    // so the screen always equals the charge.
    const t = computeTotals([line({ qty: 1, unitCents: 1000, lineDisc: 100 })], 0);
    expect(t.discount).toBe(100);
    expect(t.tax).toBe(120); // 15% of (1000 - 100 - 100)
    expect(t.total).toBe(900 + 120);
  });

  test('zero-rated and free lines never divide by zero', () => {
    const t = computeTotals([line({ unitCents: 0, qty: 5 })], 10);
    expect(t.subtotal).toBe(0);
    expect(t.discount).toBe(0);
    expect(t.total).toBe(0);
  });
});
