// Point of Sale service: checkout, voiding, refunds
// Every completed sale posts a balanced double-entry journal entry
// and deducts inventory atomically in a single transaction.

import { Store } from './store.js';
import { nextDoc } from './db/counters.js';

const TAX_RATE_DEFAULT = 0.08;

class PosService {
  constructor(store) {
    this.store = store;
  }

  // Returns price + tax for a single unit
  lineBreakdown(unitPriceCents, taxRate) {
    const tax = Math.round(unitPriceCents * taxRate);
    return { unitPriceCents, taxCents: tax, totalCents: unitPriceCents + tax };
  }

  async checkout({
    items,               // [{ productId, qty }]
    customerId = null,
    discountCents = 0,
    redeemPoints = 0,    // loyalty points to redeem (100 pts = $1)
    cashReceivedCents = null,
    paymentMethod = 'cash',
  }) {
    const db = this.store.db;

    let validation = this.validateItems(items);
    if (validation.error) return { ok: false, error: validation.error };

    const lines = validation.lines;
    const subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
    const redeemCents = this.store.centsForPoints(redeemPoints);
    let discountFinal = discountCents + redeemCents;
    if (discountFinal > subtotalCents) discountFinal = subtotalCents;

    const taxable = lines.reduce((s, l) => s + l.taxCents, 0);
    const totalCents = subtotalCents - discountFinal + taxable;
    const changeCents = cashReceivedCents != null ? cashReceivedCents - totalCents : 0;
    if (changeCents < 0) return { ok: false, error: 'INSUFFICIENT_CASH' };

    const receiptNo = await this.nextReceiptNo();

    db.exec('BEGIN');
    try {
      // 1. Verify + reserve stock for every line
      for (const l of lines) {
        const stock = this.store.getStock(l.productId);
        if (!stock || stock.quantity < l.qty) {
          db.exec('ROLLBACK');
          return { ok: false, error: `INSUFFICIENT_STOCK:${l.productId}` };
        }
      }

      // 2. Insert sale + line items
      const ptsEarned = this.store.pointsForCents(totalCents);
      const saleRes = db.prepare(
        `INSERT INTO sales (receipt_no, customer_id, subtotal_cents, discount_cents, tax_cents,
           total_cents, payment_method, cash_received_cents, change_cents, loyalty_points_earned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(receiptNo, customerId, subtotalCents, discountFinal, taxable, totalCents,
            paymentMethod, cashReceivedCents, changeCents, ptsEarned);
      const saleId = saleRes.lastInsertRowid;

      const insItem = db.prepare(
        `INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price_cents, line_total_cents, tax_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const insMove = db.prepare(
        `INSERT INTO inventory_movements (product_id, quantity, type, note)
         VALUES (?, ?, 'SALE', ?)`
      );
      const updStock = db.prepare('UPDATE inventory SET quantity = quantity - ?, updated_at = datetime(\'now\') WHERE product_id = ?');

      for (const l of lines) {
        insItem.run(saleId, l.productId, l.name, l.qty, l.unitPriceCents, l.lineTotalCents, l.taxCents);
        updStock.run(l.qty, l.productId);
        insMove.run(l.productId, -l.qty, `Sale ${receiptNo}`);
      }

      // 3. Update customer loyalty
      if (customerId) {
        db.prepare(
          `UPDATE customers SET loyalty_points = loyalty_points - ? + ?,
            total_spent_cents = total_spent_cents + ? WHERE id = ?`
        ).run(redeemPoints, ptsEarned, totalCents, customerId);
      }

      // 4. Post double-entry journal entry
      this.postSaleJournal(db, receiptNo, {
        revenueCents: subtotalCents - discountFinal,
        taxCents: taxable,
        cashReceivedMoney: totalCents,
        arMode: false,
        description: `Sale ${receiptNo} (${lines.length} items)`,
      });

      // 5. Update daily aggregate (revenue + cost + profit)
      this.postCogs(db, receiptNo, lines);
      this.updateDailyAggregate(db, new Date(), totalCents, lines);

      db.exec('COMMIT');
      return { ok: true, saleId, receiptNo, totalCents, subtotalCents, discountCents: discountFinal, taxCents: taxable, changeCents, loyaltyPointsEarned: ptsEarned, lines };
    } catch (e) {
      db.exec('ROLLBACK');
      return { ok: false, error: e.message };
    }
  }

  validateItems(items) {
    if (!Array.isArray(items) || items.length === 0) return { error: 'NO_ITEMS' };
    const lines = [];
    for (const it of items) {
      const p = this.store.db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(it.productId);
      if (!p) return { error: `PRODUCT_NOT_FOUND:${it.productId}` };
      const qty = Number(it.qty);
      if (!qty || qty <= 0) return { error: `BAD_QTY:${it.productId}` };
      const unitPrice = p.price_cents;
      const taxCents = Math.round(unitPrice * qty * p.tax_rate);
      lines.push({
        productId: p.id, name: p.name, qty,
        unitPriceCents: unitPrice,
        lineTotalCents: unitPrice * qty,
        taxCents,
        taxRate: p.tax_rate,
      });
    }
    return { lines };
  }

  nextReceiptNo() {
    const row = this.store.db.prepare("SELECT MAX(CAST(receipt_no AS INTEGER)) AS m FROM sales WHERE receipt_no GLOB '[0-9]*'").get();
    return String((row?.m ?? 0) + 1).padStart(6, '0');
  }

  // Double-entry: Debit Cash (asset) = revenue + tax, Credit Sales Revenue, Credit Tax Payable
  postSaleJournal(db, reference, { revenueCents, taxCents, cashReceivedMoney, description, arMode }) {
    const acct = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
    const entryNo = this.nextEntryNo(db);
    const er = db.prepare(
      `INSERT INTO journal_entries (entry_no, reference, description) VALUES (?, ?, ?)`
    ).run(entryNo, reference, description);
    const entryId = er.lastInsertRowid;
    const insLine = db.prepare(
      `INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?, ?, ?, ?)`
    );
    const debitAccount = arMode ? '1100' : '1000';
    // Debit cash/AR for the amount received (revenue + tax)
    insLine.run(entryId, acct(debitAccount), cashReceivedMoney, 0);
    // Credit sales revenue
    insLine.run(entryId, acct('4000'), 0, revenueCents);
    // Credit tax payable
    insLine.run(entryId, acct('4200'), 0, taxCents);

    // Update account balances for money in, revenue, tax
    this.store.db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(cashReceivedMoney, acct(debitAccount));
    this.store.db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(revenueCents, acct('4000'));
    this.store.db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(taxCents, acct('4200'));
  }

  postCogs(db, reference, lines) {
    // Debit COGS, Credit Inventory by cost of goods sold
    const totalCost = lines.reduce((s, l) => {
      const cost = this.store.db.prepare('SELECT cost_cents FROM products WHERE id = ?').get(l.productId)?.cost_cents ?? 0;
      return s + cost * l.qty;
    }, 0);
    if (totalCost <= 0) return;
    const acct = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
    const entryNo = this.nextEntryNo(db);
    const er = db.prepare(
      `INSERT INTO journal_entries (entry_no, reference, description) VALUES (?, ?, ?)`
    ).run(entryNo, `COGS-${reference}`, `Cost of goods for sale ${reference}`);
    const entryId = er.lastInsertRowid;
    const insLine = db.prepare(
      `INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?, ?, ?, ?)`
    );
    insLine.run(entryId, acct('4100'), totalCost, 0);
    insLine.run(entryId, acct('1200'), 0, totalCost);
    this.store.db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(totalCost, acct('4100'));
    this.store.db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(totalCost, acct('1200'));
  }

  nextEntryNo(db) {
    // Shared JE sequence with the retail port (src/gs) so entry_no never collides.
    return nextDoc(db, 'JE');
  }

  updateDailyAggregate(db, date, totalCents, lines = []) {
    const day = date.toISOString().slice(0, 10);
    const cost = lines.reduce((s, l) => {
      const c = db.prepare('SELECT cost_cents FROM products WHERE id = ?').get(l.productId)?.cost_cents ?? 0;
      return s + c * l.qty;
    }, 0);
    const profit = totalCents - cost;
    db.prepare(
      `INSERT INTO sales_by_day (sale_date, count, revenue_cents, cost_cents, profit_cents)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(sale_date) DO UPDATE SET
         count = count + 1,
         revenue_cents = revenue_cents + excluded.revenue_cents,
         cost_cents = cost_cents + excluded.cost_cents,
         profit_cents = profit_cents + excluded.profit_cents`
    ).run(day, totalCents, cost, profit);
  }

  voidSale(saleId, reason) {
    const db = this.store.db;
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) return { ok: false, error: 'NOT_FOUND' };
    if (sale.status !== 'complete') return { ok: false, error: 'ALREADY_VOID' };

    db.exec('BEGIN');
    try {
      // Restore inventory
      const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
      for (const it of items) {
        db.prepare('UPDATE inventory SET quantity = quantity + ? WHERE product_id = ?').run(it.qty, it.product_id);
        db.prepare('INSERT INTO inventory_movements (product_id, quantity, type, note) VALUES (?, ?, ?, ?)')
          .run(it.product_id, it.qty, 'ADJUST', `Void ${sale.receipt_no}`);
      }
      // Reverse customer loyalty/points
      if (sale.customer_id) {
        db.prepare(
          `UPDATE customers SET loyalty_points = loyalty_points - ?,
            total_spent_cents = total_spent_cents - ? WHERE id = ?`
        ).run(sale.loyalty_points_earned, sale.total_cents, sale.customer_id);
      }
      // Reverse revenue/tax journal entry
      this.postReversal(db, sale.receipt_no, sale);
      // Reverse COGS journal entry
      this.postCogsReversal(db, sale.receipt_no, items);
      // Reverse daily aggregate cost/profit
      this.reverseDailyAggregate(db, new Date(), sale.total_cents, items);
      db.prepare('UPDATE sales SET status = \'void\' WHERE id = ?').run(saleId);
      db.exec('COMMIT');
      return { ok: true };
    } catch (e) {
      db.exec('ROLLBACK');
      return { ok: false, error: e.message };
    }
  }

  postReversal(db, reference, sale) {
    const acct = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
    const entryNo = this.nextEntryNo(db);
    const er = db.prepare(
      `INSERT INTO journal_entries (entry_no, reference, description) VALUES (?, ?, 'Void ' || ?)`
    ).run(entryNo, reference, reference);
    const entryId = er.lastInsertRowid;
    // Reverse: Original was Dr Cash(revenue+tax), Cr Revenue, Cr TaxPayable.
    // Reversal: Dr Revenue, Dr TaxPayable, Cr Cash.
    const cashAmt = sale.subtotal_cents - sale.discount_cents + sale.tax_cents;
    db.prepare(
      `INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?, ?, ?, ?)`
    ).run(entryId, acct('4000'), sale.subtotal_cents - sale.discount_cents, 0);
    db.prepare(
      `INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?, ?, ?, ?)`
    ).run(entryId, acct('4200'), sale.tax_cents, 0);
    db.prepare(
      `INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?, ?, ?, ?)`
    ).run(entryId, acct('1000'), 0, cashAmt);

    this.store.db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(cashAmt, acct('1000'));
    this.store.db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(sale.subtotal_cents - sale.discount_cents, acct('4000'));
    this.store.db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(sale.tax_cents, acct('4200'));
  }

  // Reverse the COGS journal entry (Dr Inventory 1200, Cr COGS 4100)
  postCogsReversal(db, reference, items) {
    const totalCost = items.reduce((s, l) => {
      const cost = db.prepare('SELECT cost_cents FROM products WHERE id = ?').get(l.product_id)?.cost_cents ?? 0;
      return s + cost * l.qty;
    }, 0);
    if (totalCost <= 0) return;
    const acct = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
    const entryNo = this.nextEntryNo(db);
    const er = db.prepare(
      `INSERT INTO journal_entries (entry_no, reference, description) VALUES (?, ?, 'Void COGS ' || ?)`
    ).run(entryNo, `COGS-${reference}`, reference);
    const entryId = er.lastInsertRowid;
    db.prepare(
      `INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?, ?, ?, ?)`
    ).run(entryId, acct('1200'), totalCost, 0);
    db.prepare(
      `INSERT INTO journal_lines (entry_id, account_id, debits_cents, credits_cents) VALUES (?, ?, ?, ?)`
    ).run(entryId, acct('4100'), 0, totalCost);
    this.store.db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(totalCost, acct('1200'));
    this.store.db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(totalCost, acct('4100'));
  }

  reverseDailyAggregate(db, date, totalCents, items) {
    const day = date.toISOString().slice(0, 10);
    const cost = items.reduce((s, l) => {
      const c = db.prepare('SELECT cost_cents FROM products WHERE id = ?').get(l.product_id)?.cost_cents ?? 0;
      return s + c * l.qty;
    }, 0);
    db.prepare(
      `UPDATE sales_by_day SET count = MAX(count - 1, 0), revenue_cents = revenue_cents - ?,
        cost_cents = cost_cents - ?, profit_cents = profit_cents - ?
       WHERE sale_date = ?`
    ).run(totalCents, cost, totalCents - cost, day);
  }
}

export { PosService };
