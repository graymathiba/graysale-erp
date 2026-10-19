import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify, createHash } from 'node:crypto';
import { makeApp, seedCatalog, admin, assertBalanced } from './helpers.js';
import {
  FiscalService,
  buildEcdsaCsr,
  canonicalReceiptContent,
  signContent,
  verifySignature,
} from '../src/services/fiscal.js';

function enableFdms(app, mode = 'simulator') {
  const ups = app.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  ups.run('fdms.enabled', '1');
  ups.run('fdms.mode', mode);
  ups.run('fdms.device_id', '1012345678');
  ups.run('fdms.serial_no', 'GS-0001');
  ups.run('fdms.tin', '1023456789');
  ups.run('fdms.currency', 'USD');
}

// Minimal DER reader for the CSR self-signature check.
function derPos(buf, expectTag) {
  const tag = buf[0];
  let i = 1;
  let len = buf[i] & 0x7f;
  const long = buf[i] & 0x80;
  i += 1;
  if (long) {
    const n = len;
    len = 0;
    for (let k = 0; k < n; k++) {
      len = len * 256 + buf[i];
      i += 1;
    }
  }
  assert.equal(tag, expectTag, `expected tag 0x${expectTag.toString(16)}, got 0x${tag.toString(16)}`);
  return { content: buf.subarray(i, i + len), end: i + len };
}

function selfVerifyCsr(csrPem) {
  const b64 = csrPem
    .replace(/-----BEGIN CERTIFICATE REQUEST-----/, '')
    .replace(/-----END CERTIFICATE REQUEST-----/, '')
    .replace(/\s+/g, '');
  const der = Buffer.from(b64, 'base64');
  const top = derPos(der, 0x30); // CertificationRequest ::= SEQUENCE{ crInfo, sigAlg, sig }
  const wrap = { content: top.content };
  const crInfo = derPos(wrap.content, 0x30); // CertificationRequestInfo ::= SEQUENCE
  const crInfoBytes = wrap.content.subarray(0, crInfo.end);
  wrap.content = wrap.content.subarray(crInfo.end);
  const sigAlg = derPos(wrap.content, 0x30); // signatureAlgorithm
  wrap.content = wrap.content.subarray(sigAlg.end);
  const sig = derPos(wrap.content, 0x03); // BIT STRING signature
  const raw = sig.content.subarray(1); // drop unused-bits byte
  return { crInfo: crInfoBytes, signature: raw };
}

test('buildEcdsaCsr produces a structurally valid, self-signed PKCS#10 request', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const csr = buildEcdsaCsr({ privateKey, publicKey, commonName: 'CLIENT-GS-0001-1012345678' });
  assert.match(csr, /^-----BEGIN CERTIFICATE REQUEST-----/);
  const { crInfo, signature } = selfVerifyCsr(csr);
  const verifier = createVerify('sha256');
  verifier.update(crInfo);
  verifier.end();
  assert.equal(
    verifier.verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, signature),
    true,
    'CSR must be self-signed by the device key',
  );
});

test('signContent / verifySignature round-trip and canonical content is deterministic', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const sample = {
    invoiceNo: 'SALE-0001',
    receiptCounter: 1,
    receiptGlobalNo: 12,
    receiptDate: '2026-09-15T10:00:00.000Z',
    receiptCurrency: 'USD',
    receiptTotal: 51.75,
    receiptType: 'FiscalInvoice',
    receiptLinesTaxInclusive: false,
    receiptLines: [
      {
        receiptLineType: 'Sale',
        receiptLineNo: 1,
        receiptLineName: 'A',
        receiptLineQuantity: 1,
        receiptLinePrice: 45,
        receiptLineTotal: 45,
        taxID: 1,
      },
    ],
    receiptTaxes: [{ taxID: 1, salesAmountWithTax: 45, taxAmount: 6.75 }],
    receiptPayments: [{ moneyTypeCode: 'Cash', paymentAmount: 51.75 }],
  };
  const c1 = canonicalReceiptContent(sample);
  const c2 = canonicalReceiptContent(sample);
  assert.equal(c1, c2);
  const sig = signContent(key, c1);
  assert.equal(sig.hash, createHash('sha256').update(c1).digest('base64'));
  assert.equal(verifySignature(publicKey.export({ type: 'spki', format: 'pem' }), c1, sig.signature), true);
  assert.equal(verifySignature(publicKey.export({ type: 'spki', format: 'pem' }), c1 + 'x', sig.signature), false);
});

test('invoice DTO lines, taxes and payments balance to the sale total', () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  enableFdms(app);
  const fiscal = new FiscalService({ db: app.db });
  const line = {
    product_id: A.id,
    product_name: 'Product A',
    qty: 1,
    unit_price_cents: 4500,
    line_discount_cents: 0,
    tax_cents: 675,
    line_total_cents: 5175,
  };
  const dto = fiscal.buildReceiptDto(
    {
      id: 1,
      doc_no: 'SALE-0001',
      type: 'SALE',
      subtotal_cents: 4500,
      discount_cents: 0,
      meta: JSON.stringify({ payments: { CASH: 5175 } }),
      lines: [line],
    },
    { serial: 1, counter: 1 },
  );
  assert.equal(dto.receiptTotal, 51.75);
  const sumLines = dto.receiptLines.reduce((s, l) => s + l.receiptLineTotal, 0);
  assert.equal(sumLines, 45);
  const sumTax = dto.receiptTaxes.reduce((s, t) => s + t.taxAmount, 0);
  assert.equal(sumTax, 6.75);
  const sumPayments = dto.receiptPayments.reduce((s, p) => s + p.paymentAmount, 0);
  assert.equal(sumPayments, dto.receiptTotal);
  assert.equal(dto.receiptLines[0].receiptLineType, 'Sale');
  assert.equal(dto.receiptPayments[0].moneyTypeCode, 'Cash');
});

test('register (simulator) provisions the device state and is repeatable', async () => {
  const app = makeApp();
  enableFdms(app);
  const user = admin(app);
  const st = await app.fiscal.register({ user });
  assert.equal(st.registered, true);
  assert.equal(st.mode, 'simulator');
  assert.equal(st.deviceId, '1012345678');
  const again = await app.fiscal.register({ user });
  assert.equal(again.registered, true);
});

test('a paid sale is stamped and queued, then submitted to the simulator with monotonic serials', async () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  enableFdms(app);
  const user = admin(app);
  await app.fiscal.register({ user });

  const sale1 = app.pos.checkout({
    items: [{ productId: A.id, qty: 1 }],
    payments: [{ method: 'CASH', amount: 6000 }],
    user,
  });
  assert.match(sale1.fiscal_receipt_no, /^F-000001$/);
  assert.ok(sale1.fiscal_hash, 'hash stamped');
  assert.equal(sale1.fiscal_serial, 1);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS c FROM fiscal_queue WHERE status = 'PENDING'").get().c, 1);

  const sale2 = app.pos.checkout({
    items: [{ productId: A.id, qty: 1 }],
    payments: [{ method: 'CASH', amount: 6000 }],
    user,
  });
  assert.equal(sale2.fiscal_receipt_no, 'F-000002');
  assert.equal(sale2.fiscal_serial, 2);

  const sub = await app.fiscal.submitQueue({ user });
  assert.equal(sub.submitted, 2);
  assert.equal(sub.results[0].receiptId, 1);
  assert.equal(sub.results[1].receiptId, 2);
  assert.ok(sub.results[0].serverSignature.signature, 'simulator counter-signs the receipt');
  assert.equal(app.db.prepare("SELECT COUNT(*) AS c FROM fiscal_queue WHERE status = 'SUBMITTED'").get().c, 2);
  assert.equal(app.pos.getOrder(sale1.id).fiscal_receipt_id, 1);
  // Day counters aggregate taxes + money from submitted receipts.
  const st = app.fiscal.status(user);
  assert.equal(st.globalNo, 2);
  assert.equal(st.receiptCounter, 2);
  const counters = JSON.parse(
    app.db.prepare("SELECT value FROM fiscal_meta WHERE key = 'fiscal.day.counters'").get().value,
  );
  assert.equal(counters.tax['3'][0], 9000); // 2 Ã— 45.00 sales at 15% (taxID 3)
  assert.equal(counters.tax['3'][1], 1350);
  assert.equal(counters.money.Cash, 10350);
});

test('openDay/closeDay bookend a fiscal day and reset counters', async () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  enableFdms(app);
  const user = admin(app);
  await app.fiscal.register({ user });
  const op = await app.fiscal.openDay({ user });
  assert.equal(op.dayNo, 1);
  app.pos.checkout({ items: [{ productId: A.id, qty: 1 }], payments: [{ method: 'CASH', amount: 6000 }], user });
  const sub = await app.fiscal.submitQueue({ user });
  assert.equal(sub.submitted, 1);
  const cl = await app.fiscal.closeDay({ user });
  assert.equal(cl.dayNo, 0);
  assert.equal(cl.receiptCounter, 0);
  assert.equal(app.db.prepare("SELECT value FROM fiscal_meta WHERE key = 'fiscal.day.counters'").get().value, '{}');
});

test('disabled or unregistered fdms never stamps or queues sales', async () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  const user = admin(app);
  // fdms disabled (not enabled): no fiscal fields even though registered.
  const enabling = app.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  enabling.run('fdms.device_id', '1012345678');
  enabling.run('fdms.serial_no', 'GS-0000');
  await app.fiscal.register({ user });
  const sale = app.pos.checkout({
    items: [{ productId: A.id, qty: 1 }],
    payments: [{ method: 'CASH', amount: 6000 }],
    user,
  });
  assert.equal(sale.fiscal_receipt_no, null);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS c FROM fiscal_queue').get().c, 0);
});

test('refund (cash) is queued as a CreditNote after finalization', async () => {
  const app = makeApp();
  const { A } = seedCatalog(app);
  enableFdms(app);
  const user = admin(app);
  await app.fiscal.register({ user });
  const sale = app.pos.checkout({
    items: [{ productId: A.id, qty: 2 }],
    payments: [{ method: 'CASH', amount: 11000 }],
    user,
  });
  const refund = app.pos.refund({ saleId: sale.id, items: [{ productId: A.id, qty: 1 }], user });
  assert.equal(refund.status, 'PAID');
  assert.match(refund.fiscal_receipt_no, /^F-000002$/);
  const row = app.db.prepare('SELECT payload FROM fiscal_queue WHERE order_id = ?').get(refund.id);
  const { dto } = JSON.parse(row.payload);
  assert.equal(dto.receiptType, 'CreditNote');
  const total = dto.receiptPayments.reduce((s, p) => s + p.paymentAmount, 0);
  assert.equal(total, -51.75, 'refund payment is negated');
  const sumLines = dto.receiptLines.reduce((s, l) => s + l.receiptLineTotal, 0);
  assert.equal(sumLines, -45);
  assertBalanced(app);
});
