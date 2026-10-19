import { createHash, createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import { badRequest, conflict } from '../lib/errors.js';
import { resolveTenantId } from '../lib/tenant.js';

// ---------------------------------------------------------------------------
// ZIMRA FDMS fiscal receipts (direct REST integration, fdmsapi.zimra.co.zw).
//
// Two operating modes:
//   * simulator  (default) — a full in-process loopback: local ECDSA device on
//     a fabricated self-signed certificate, local "server" counter-signature,
//     monotonic receipt/global counters. Lets the whole register work offline
//     before the Tax Authority assigns a real device.
//   * live       — mTLS against the published swagger:
//       POST /Public/v1/{deviceID}/RegisterDevice      (CSR -> device cert)
//       POST /Device/v1/{deviceID}/OpenDay
//       POST /Device/v1/{deviceID}/SubmitReceipt       ({ receipt: ReceiptDto })
//       POST /Device/v1/{deviceID}/CloseDay
//
// Receipts are queued locally and flushed to ZIMRA; an offline register never
// loses a taxed sale. As a safety rule the exact byte order of the canonical
// "content hashed and signed by the device" (and its base64 encoding of the
// 32-byte digest) MUST be reconciled against §6.2 of the current ZIMRA FDMS
// Device Specification before a live device goes to production — it is the
// single constant we cannot verify offline. It lives in ONE function:
// canonicalReceiptContent() / canonicalCloseDayContent().
//
// taxID is ZIMRA's per-rate identifier assigned at device registration. We
// default to the seeded graysale rates and expose an override in fiscal_meta
// ('taxid.bps' = JSON { "1500": 3, "750": 2, "0": 1 }).
// ---------------------------------------------------------------------------

const DEFAULT_TAXID = { 0: 1, 750: 2, 1500: 3 };
const ZERO_PAD_DEVICE_ID = 10;

export const MONEY_TYPE = {
  CASH: 'Cash',
  CARD: 'Card',
  MOBILE: 'MobileWallet',
  ECOCASH: 'MobileWallet',
  BANK: 'BankTransfer',
  CREDIT: 'Credit',
};
const RECEIPT_TYPE = { SALE: 'FiscalInvoice', REFUND: 'CreditNote' };

const dollar = (cents) => (cents / 100).toFixed(2);
const pct = (rateBps) => Number(rateBps) / 10000;

// ------------------------------------------------------------------ helpers

export function sha256(raw) {
  return createHash('sha256').update(raw).digest();
}

// The canonical content the device signs for a receipt. Deterministic, ordered,
// and derived exclusively from the wire DTO so both sides can reproduce it.
export function canonicalReceiptContent(dto) {
  const parts = [
    dto.invoiceNo,
    String(dto.receiptCounter),
    String(dto.receiptGlobalNo),
    dto.receiptDate,
    dto.receiptCurrency,
    dollar(Math.round(dto.receiptTotal * 100)),
    String(dto.receiptType),
    String(dto.receiptLinesTaxInclusive),
  ];
  for (const l of dto.receiptLines) {
    parts.push(
      l.receiptLineType,
      String(l.receiptLineNo),
      l.receiptLineName,
      String(l.receiptLineQuantity),
      dollar(Math.round(l.receiptLinePrice * 100)),
      dollar(Math.round(l.receiptLineTotal * 100)),
      String(l.taxID),
    );
  }
  for (const t of dto.receiptTaxes) {
    parts.push(String(t.taxID), dollar(Math.round(t.salesAmountWithTax * 100)), dollar(Math.round(t.taxAmount * 100)));
  }
  for (const p of dto.receiptPayments) {
    parts.push(p.moneyTypeCode, dollar(Math.round(p.paymentAmount * 100)));
  }
  return parts.join('|');
}

export function signContent(keyPem, content) {
  const signer = createSign('sha256');
  signer.update(content);
  signer.end();
  const digest = sha256(content);
  const signature = signer.sign({ key: keyPem, dsaEncoding: 'ieee-p1363' });
  return {
    hash: digest.toString('base64'),
    signature: signature.toString('base64'),
  };
}

export function verifySignature(keyPem, content, signatureB64) {
  const verifier = createVerify('sha256');
  verifier.update(content);
  verifier.end();
  return verifier.verify({ key: keyPem, dsaEncoding: 'ieee-p1363' }, Buffer.from(signatureB64, 'base64'));
}

// ------------------------------------------------------------------ CSR (DER)

const SEQ = 0x30,
  INT = 0x02,
  BITSTR = 0x03,
  OID = 0x06,
  UTF8 = 0x0c,
  A0 = 0xa0;

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tl(tag, body) {
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
}
function BigInteger(n) {
  let b = BigInt(n).toString(16);
  if (b.length % 2) b = '0' + b;
  const buf = Buffer.from(b, 'hex');
  return buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf;
}

const pubPoint = (pub) => {
  const jwk = pub.export({ format: 'jwk' });
  let x = BigInt('0x' + Buffer.from(jwk.x, 'base64url').toString('hex'));
  let y = BigInt('0x' + Buffer.from(jwk.y, 'base64url').toString('hex'));
  const X = Array.from(BigInteger(x));
  const Y = Array.from(BigInteger(y));
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(X), Buffer.from(Y)]);
};

function oid(s) {
  const d = s.split('.').map(Number);
  let out = Buffer.from([40 * d[0] + d[1]]);
  for (let i = 2; i < d.length; i++) {
    let v = d[i];
    const b = [];
    do {
      b.unshift((v & 0x7f) | (b.length ? 0x80 : 0));
      v >>= 7;
    } while (v);
    out = Buffer.concat([out, Buffer.from(b)]);
  }
  return tl(OID, out);
}
const ECDSA_SHA256 = oid('1.2.840.10045.4.3.2');
const EC_PUBLIC_KEY = oid('1.2.840.10045.2.1');
const PRIME256 = oid('1.2.840.10045.3.1.7');

// Build a PKCS#10 CSR for a P-256 ECDSA key with CN = `client-serial-deviceID`.
export function buildEcdsaCsr({ privateKey, publicKey, commonName }) {
  const version = tl(INT, BigInteger(0));
  const subject = tl(
    SEQ,
    Buffer.concat([tl(SEQ, Buffer.concat([tl(OID, oid('2.5.4.3')), tl(UTF8, Buffer.from(commonName, 'utf8'))]))]),
  );
  const pkAlgorithm = tl(SEQ, Buffer.concat([tl(OID, EC_PUBLIC_KEY), tl(SEQ, tl(OID, PRIME256))]));
  const publicKeyInfo = tl(
    SEQ,
    Buffer.concat([pkAlgorithm, tl(BITSTR, Buffer.concat([Buffer.from([0]), pubPoint(publicKey)]))]),
  );
  // CertificationRequestInfo ::= SEQUENCE { version, subject, subjectPKInfo, attributes [0] }
  const tbsContent = Buffer.concat([version, subject, publicKeyInfo, Buffer.from([A0, 0x00])]);
  const crInfo = tl(SEQ, tbsContent);
  const signature = signWithKey(privateKey, crInfo);
  const algorithmId = tl(SEQ, Buffer.concat([tl(OID, ECDSA_SHA256), Buffer.from([0x05, 0x00])]));
  const csr = tl(SEQ, Buffer.concat([crInfo, algorithmId, tl(BITSTR, Buffer.concat([Buffer.from([0]), signature]))]));
  const b64 = csr
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n');
  return `-----BEGIN CERTIFICATE REQUEST-----\n${b64}\n-----END CERTIFICATE REQUEST-----`;
}

function signWithKey(key, data) {
  const s = createSign('sha256');
  s.update(data);
  s.end();
  return s.sign({ key, dsaEncoding: 'ieee-p1363' });
}

export function rsaOrEcCertSubjectCN(certPem) {
  // Best-effort readability of the device CN from a registration certificate.
  const m = /CN=([^,\n]+)/.exec(certPem);
  return m ? m[1].trim() : '';
}

// ------------------------------------------------------------------ service

export class FiscalService {
  constructor({ db }) {
    this.db = db;
  }

  // -- config ---------------------------------------------------------------
  config() {
    const g = (k, def = '') => this.db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? def;
    return {
      enabled: g('fdms.enabled') === '1',
      mode: g('fdms.mode', 'simulator'),
      baseUrl: g('fdms.base_url', 'https://fdmsapi.zimra.co.zw'),
      deviceId: g('fdms.device_id'),
      serialNo: g('fdms.serial_no'),
      activationKey: g('fdms.activation_key'),
      modelName: g('fdms.model_name'),
      modelVersion: g('fdms.model_version'),
      tin: g('fdms.tin'),
      currency: g('fdms.currency', 'USD'),
      workstation: g('fdms.workstation'),
    };
  }

  _meta(tenantId, key, def = null) {
    const r = this.db.prepare('SELECT value FROM fiscal_meta WHERE tenant_id = ? AND key = ?').get(tenantId, key);
    return r ? r.value : def;
  }
  _setMeta(tenantId, key, value) {
    this.db
      .prepare(
        `INSERT INTO fiscal_meta (tenant_id, key, value) VALUES (?, ?, ?)
      ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
      )
      .run(tenantId, key, value ?? null);
  }

  _state(tenantId) {
    const n = (k, d = 0) => Number(this._meta(tenantId, k, d) ?? d);
    return {
      dayNo: n('fiscal.day_no'),
      receiptCounter: n('fiscal.receipt_counter'),
      globalNo: n('fiscal.global_no'),
      registered: this._meta(tenantId, 'device.key') ? true : false,
    };
  }

  // -- device registration --------------------------------------------------
  async register({ user }) {
    const cfg = this.config();
    const tenantId = resolveTenantId(this.db, user?.tenantId);
    if (!cfg.deviceId || !cfg.serialNo) throw badRequest('FDMS_REQUIRES_DEVICE_ID_AND_SERIAL');
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

    if (cfg.mode === 'live') {
      if (!cfg.modelName || !cfg.modelVersion) throw badRequest('FDMS_REQUIRES_MODEL');
      if (!cfg.activationKey) throw badRequest('FDMS_REQUIRES_ACTIVATION_KEY');
      const company = this.db.prepare('SELECT company_name FROM company_settings WHERE id = 1').get();
      const client = (company?.company_name || 'CLIENT').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'CLIENT';
      const cn = `${client}-${cfg.serialNo}-${String(cfg.deviceId).padStart(ZERO_PAD_DEVICE_ID, '0')}`;
      const csr = buildEcdsaCsr({ privateKey, publicKey, commonName: cn });
      const deviceID = Number(cfg.deviceId);
      const url = `${cfg.baseUrl.replace(/\/$/, '')}/Public/v1/${deviceID}/RegisterDevice`;
      const payload = { activationKey: cfg.activationKey, certificateRequest: csr };
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          DeviceModelName: cfg.modelName,
          DeviceModelVersion: cfg.modelVersion,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw conflict(
          `FDMS_REGISTER ${res.status}: ${data.detail || data.title || JSON.stringify(data).slice(0, 200)}`,
        );
      this._setMeta(tenantId, 'device.cert', data.certificate);
    } else {
      // Simulator: fabricate a self-signed certificate body (not CA-validated).
      const certBody = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const selfPem = certBody.privateKey.export({ type: 'pkcs8', format: 'pem' });
      const thumb = sha256(selfPem).toString('hex').slice(0, 32);
      this._setMeta(
        tenantId,
        'device.cert',
        `-----BEGIN SIMULATOR DEVICE CERT-----\n${Buffer.from(`${cfg.deviceId}|${cfg.serialNo}|${thumb}`).toString('base64')}\n-----END SIMULATOR DEVICE CERT-----`,
      );
      this._setMeta(tenantId, 'device.thumbprint', thumb);
      // A dedicated "server" key so the counter-signature can be verified.
      if (!this._meta(tenantId, 'server.key')) {
        const server = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        this._setMeta(tenantId, 'server.key', server.privateKey.export({ type: 'pkcs8', format: 'pem' }));
        this._setMeta(tenantId, 'server.pub', server.publicKey.export({ type: 'spki', format: 'pem' }));
      }
    }
    this._setMeta(tenantId, 'device.key', keyPem);
    this._setMeta(tenantId, 'device.thumbprint', createHash('sha1').update(keyPem).digest('hex'));
    this._setMeta(tenantId, 'taxid.bps', JSON.stringify(DEFAULT_TAXID));
    return this.status(user);
  }

  // -- days -----------------------------------------------------------------
  async openDay({ user }) {
    const tenantId = resolveTenantId(this.db, user?.tenantId);
    const cfg = this.config();
    const st = this._state(tenantId);
    if (!st.registered) throw conflict('FDMS_NOT_REGISTERED');
    if (st.dayNo > 0) return this.status(user); // already open
    const nextDay = st.dayNo + 1;
    if (cfg.mode === 'live') {
      const url = `${cfg.baseUrl.replace(/\/$/, '')}/Device/v1/${cfg.deviceId}/OpenDay`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiscalDayOpened: new Date().toISOString() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw conflict(`FDMS_OPENDAY ${res.status}: ${d.detail || d.title}`);
      }
    }
    this._setMeta(tenantId, 'fiscal.day_no', String(nextDay));
    this._setMeta(tenantId, 'fiscal.receipt_counter', '0');
    this._setMeta(tenantId, 'fiscal.last_opened', new Date().toISOString());
    return this.status(user);
  }

  async closeDay({ user }) {
    const tenantId = resolveTenantId(this.db, user?.tenantId);
    const cfg = this.config();
    const st = this._state(tenantId);
    if (!st.registered) throw conflict('FDMS_NOT_REGISTERED');
    if (st.dayNo === 0) throw conflict('FDMS_NO_DAYS_OPEN');
    const counters = JSON.parse(this._meta(tenantId, 'fiscal.day.counters', '{}') || '{}');
    const fiscalDayCounters = buildDayCounters(counters);
    const content = `CloseDay|${st.dayNo}|${st.receiptCounter}|${JSON.stringify(fiscalDayCounters)}`;
    const sig = signContent(this._meta(tenantId, 'device.key'), content);
    if (cfg.mode === 'live') {
      const url = `${cfg.baseUrl.replace(/\/$/, '')}/Device/v1/${cfg.deviceId}/CloseDay`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fiscalDayNo: st.dayNo,
          receiptCounter: st.receiptCounter,
          fiscalDayCounters,
          fiscalDayDeviceSignature: sig,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw conflict(`FDMS_CLOSEDAY ${res.status}: ${d.detail || d.title}`);
      }
    }
    this._setMeta(tenantId, 'fiscal.day_no', '0');
    this._setMeta(tenantId, 'fiscal.receipt_counter', '0');
    this._setMeta(tenantId, 'fiscal.last_closed', new Date().toISOString());
    this._setMeta(tenantId, 'fiscal.day.counters', '{}');
    return this.status(user);
  }

  // -- receipt plumbing ------------------------------------------------------

  _rateForLine(line) {
    const row = this.db
      .prepare(
        `
      SELECT tc.rate_bps FROM products p LEFT JOIN tax_classes tc ON tc.id = p.tax_class_id WHERE p.id = ?`,
      )
      .get(line.product_id);
    return row ? Number(row.rate_bps) : 0;
  }

  // Start a sale/refund fiscal work item: build the wire ReceiptDto, sign it
  // with the device key, stamp the order and queue it for ZIMRA. Serial and
  // per-day counter are allocated here (not on submission) so an offline
  // register keeps monotonic fiscal numbers.
  enqueue(order, user) {
    const cfg = this.config();
    const tenantId = resolveTenantId(this.db, user?.tenantId);
    if (!cfg.enabled) return order;
    const st = this._state(tenantId);
    if (!st.registered) return order; // not registered yet: nothing to queue
    if (st.dayNo === 0) {
      // Simulator/dev mode rarely opens a day explicitly; auto-open day one.
      this._setMeta(tenantId, 'fiscal.day_no', '1');
      this._setMeta(tenantId, 'fiscal.receipt_counter', '0');
    }
    const serial = st.globalNo + 1;
    const counter = st.receiptCounter + 1;
    const dto = this.buildReceiptDto(order, { serial, counter });
    const content = canonicalReceiptContent(dto);
    const sig = signContent(this._meta(tenantId, 'device.key'), content);
    const receiptNo = `F-${String(serial).padStart(6, '0')}`;
    this.db
      .prepare('UPDATE orders SET fiscal_receipt_no = ?, fiscal_hash = ?, fiscal_serial = ? WHERE id = ?')
      .run(receiptNo, sig.hash, serial, order.id);
    this.db
      .prepare(`INSERT INTO fiscal_queue (tenant_id, order_id, serial, payload, status) VALUES (?, ?, ?, ?, 'PENDING')`)
      .run(tenantId, order.id, serial, JSON.stringify({ dto, deviceSignature: sig, content }));
    this._setMeta(tenantId, 'fiscal.global_no', String(serial));
    this._setMeta(tenantId, 'fiscal.receipt_counter', String(counter));
    return this.getOrderStamped(order.id, tenantId);
  }

  getOrderStamped(orderId, tenantId) {
    return this.db
      .prepare('SELECT * FROM orders WHERE id = ? AND tenant_id = ?')
      .get(orderId, resolveTenantId(this.db, tenantId));
  }

  // Build ReceiptDto (swagger /Device-v1) from a PAID order.
  buildReceiptDto(order, opts = {}) {
    const cfg = this.config();
    const tenantId = resolveTenantId(this.db); // default tenant: single-instance
    const st = this._state(tenantId);
    const serial = opts.serial ?? st.globalNo + 1;
    const counter = opts.counter ?? (st.dayNo > 0 ? st.receiptCounter + 1 : 1);
    // Persisted order_lines carry line_total_cents / line_discount_cents /
    // tax_cents; line_gross (subtotal before line discount) is derived.
    const lines = (order.lines || []).map((l) => ({
      ...l,
      rateBps: this._rateForLine(l),
      line_discount: l.line_discount_cents || 0,
      line_gross: (l.line_total_cents || 0) + (l.line_discount_cents || 0) - (l.tax_cents || 0),
    }));
    const subtotal = order.subtotal_cents;
    const discount = order.discount_cents;
    const sign = order.type === 'REFUND' ? -1 : 1;
    const isRefund = order.type === 'REFUND';

    // Replicate PosService._totals discount split so the fiscal totals agree
    // exactly with the journaled sale.
    const nets = [];
    for (const l of lines) {
      const portion = subtotal ? Math.round((l.line_gross * 1e6) / subtotal) : 0;
      const alloc = discount ? Math.round((discount * portion) / 1e6) : 0;
      const net = l.line_gross - l.line_discount - alloc;
      nets.push({ l, net, tax: Math.round((net * (l.rateBps || 0)) / 10000) });
    }

    // Lines balance to the discounted subtotal: Sale lines carry the gross
    // figure, every discount (line-level and order-level) is an explicit
    // Discount line. Sum(lines) == total - order.discount_cents.
    const receiptLines = [];
    const lineLevelDiscount = lines.reduce((s, l) => s + (l.line_discount || 0), 0);
    const orderLevelDiscount = discount - lineLevelDiscount;
    nets.forEach(({ l }, i) => {
      const shared = { taxID: this._taxIdFor(l.rateBps, tenantId), taxPercent: Math.round(pct(l.rateBps) * 100) / 100 };
      if (l.line_gross > 0) {
        receiptLines.push({
          receiptLineType: 'Sale',
          receiptLineNo: i + 1,
          receiptLineName: l.product_name.slice(0, 200),
          receiptLineQuantity: l.qty,
          receiptLinePrice: l.qty ? round2(l.unit_price_cents / 100) : 0,
          receiptLineTotal: round2(l.line_gross / 100),
          ...shared,
        });
      }
      if (l.line_discount > 0) {
        receiptLines.push({
          receiptLineType: 'Discount',
          receiptLineNo: i + 1,
          receiptLineName: 'Discount',
          receiptLineQuantity: 1,
          receiptLinePrice: 0,
          receiptLineTotal: round2(-l.line_discount / 100),
          taxID: shared.taxID,
          taxPercent: shared.taxPercent,
        });
      }
    });
    if (orderLevelDiscount > 0) {
      receiptLines.push({
        receiptLineType: 'Discount',
        receiptLineNo: nets.length + 1,
        receiptLineName: 'Order Discount',
        receiptLineQuantity: 1,
        receiptLinePrice: 0,
        receiptLineTotal: round2(-orderLevelDiscount / 100),
        taxID: this._taxIdFor(0, tenantId),
        taxPercent: 0,
      });
    }
    if (isRefund) for (const ln of receiptLines) ln.receiptLineTotal = round2(-Math.abs(ln.receiptLineTotal));

    // Taxes per rate.
    const byRate = new Map();
    for (const { l, net, tax } of nets) {
      const r = String(l.rateBps || 0);
      const entry = byRate.get(r) || { base: 0, tax: 0, bps: l.rateBps || 0 };
      entry.base += net;
      entry.tax += tax;
      byRate.set(r, entry);
    }
    const receiptTaxes = [];
    for (const { bps, base, tax } of byRate.values()) {
      receiptTaxes.push({
        taxID: this._taxIdFor(bps, tenantId),
        taxPercent: Math.round(pct(bps) * 100) / 100,
        salesAmountWithTax: round2((base * sign) / 100),
        taxAmount: round2((tax * sign) / 100),
      });
    }

    // Payments: per-method splits from the order meta (or a single implicit one).
    let meta = {};
    try {
      meta = JSON.parse(order.meta || '{}');
    } catch {
      meta = {};
    }
    let splits = { ...(meta.payments || {}) };
    const change = Number(meta.change ?? 0);
    // An over-tendered cash sale recorded the raw input; trim the change so the
    // receipt payment matches what the journal applied (mirrors checkout's
    // appliedCash / appliedBank split).
    if (change > 0 && (splits.CASH || 0) >= change) splits.CASH = Math.max(0, (splits.CASH || 0) - change);
    if (change > 0 && (splits.CASH || 0) === 0 && splits.CARD) splits.CARD = Math.max(0, splits.CARD - change);
    let paymentTotal = nets.reduce((s, x) => s + x.net + x.tax, 0);
    const paymentEntries = [];
    let accounted = 0;
    for (const [method, cents] of Object.entries(splits)) {
      if (!MONEY_TYPE[method]) continue;
      const amt = (cents / 100) * sign;
      if (amt !== 0) paymentEntries.push({ moneyTypeCode: MONEY_TYPE[method], paymentAmount: round2(amt) });
      accounted += Number(cents);
    }
    if (accounted !== paymentTotal || paymentEntries.length === 0) {
      paymentEntries.length = 0;
      paymentEntries.push({ moneyTypeCode: 'MobileWallet', paymentAmount: round2((paymentTotal * sign) / 100) });
    }

    const dto = {
      receiptType: RECEIPT_TYPE[order.type] || 'FiscalInvoice',
      receiptCurrency: (cfg.currency || 'USD').slice(0, 3),
      receiptCounter: counter,
      receiptGlobalNo: serial,
      invoiceNo: order.doc_no.slice(0, 50),
      receiptDate: new Date().toISOString(),
      receiptLinesTaxInclusive: false,
      receiptLines,
      receiptTaxes,
      receiptPayments: paymentEntries,
      receiptTotal: round2((paymentTotal * sign) / 100),
      receiptNotes: order.note ? String(order.note).slice(0, 500) : null,
      buyerData: null,
      receiptPrintForm: 'Receipt48',
    };
    return dto;
  }

  _taxIdFor(rateBps, tenantId) {
    scan: {
      const raw = this._meta(tenantId, 'taxid.bps');
      if (!raw) break scan;
      const map = JSON.parse(raw);
      return map[String(rateBps)] ?? Number(Object.keys(map)[Object.keys(map).length - 1] ?? 1);
    }
    return DEFAULT_TAXID[String(rateBps)] ?? 1;
  }

  // -- queue ----------------------------------------------------------------
  queue({ tenantId, status }) {
    return this.db
      .prepare(
        `SELECT q.* FROM fiscal_queue q WHERE q.tenant_id = ? ${status ? 'AND q.status = ?' : ''} ORDER BY q.id ASC`,
      )
      .all(resolveTenantId(this.db, tenantId), ...(status ? [status] : []));
  }

  async submitQueue({ user, limit = 20 }) {
    const tenantId = resolveTenantId(this.db, user?.tenantId);
    const cfg = this.config();
    const st = this._state(tenantId);
    if (!st.registered) throw conflict('FDMS_NOT_REGISTERED');
    if (st.dayNo === 0 && cfg.mode === 'live') await this.openDay({ user });
    const rows = this.db
      .prepare("SELECT * FROM fiscal_queue WHERE tenant_id = ? AND status = 'PENDING' ORDER BY id ASC LIMIT ?")
      .all(tenantId, limit);
    const results = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload);
      let outcome;
      if (cfg.mode === 'live') {
        outcome = await this._submitLive(cfg, row, payload);
      } else {
        outcome = this._submitSimulator(row, payload, st);
      }
      results.push(outcome);
    }
    return { submitted: results.filter((r) => r.ok && r.stale === undefined && r.receiptId).length, results };
  }

  async _submitLive(cfg, row, payload) {
    const url = `${cfg.baseUrl.replace(/\/$/, '')}/Device/v1/${cfg.deviceId}/SubmitReceipt`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receipt: payload.dto }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 422) {
        this.db
          .prepare("UPDATE fiscal_queue SET status = 'REJECTED', error = ?, attempts = attempts + 1 WHERE id = ?")
          .run(data.detail || data.errorCode || 'FDMS_REJECTED', row.id);
        return { id: row.id, ok: false, rejected: true, error: data.detail || data.errorCode };
      }
      if (!res.ok) {
        this.db
          .prepare('UPDATE fiscal_queue SET error = ?, attempts = attempts + 1 WHERE id = ?')
          .run(`HTTP ${res.status}`, row.id);
        return { id: row.id, ok: false, retry: true, error: data.detail || `HTTP ${res.status}` };
      }
      const receiptId = Number(data.receiptID);
      this._afterSubmit(row, data, receiptId, data.receiptServerSignature?.signature || null);
      return { id: row.id, ok: true, receiptId, serverSignature: data.receiptServerSignature };
    } catch (e) {
      this.db
        .prepare('UPDATE fiscal_queue SET error = ?, attempts = attempts + 1 WHERE id = ?')
        .run(e.message.slice(0, 200), row.id);
      return { id: row.id, ok: false, retry: true, error: e.message };
    }
  }

  _submitSimulator(row, payload) {
    const tenantId = String(row.tenant_id);
    const serverKey = this._meta(tenantId, 'server.key');
    const serverSig = serverKey
      ? signContent(serverKey, payload.content)
      : { hash: sha256(payload.content).toString('base64'), signature: '' };
    const receiptId = Number(row.serial);
    this._afterSubmit(row, { receiptID: receiptId, receiptServerSignature: serverSig }, receiptId, serverSig.signature);
    return {
      id: row.id,
      ok: true,
      receiptId,
      serverSignature: { hash: serverSig.hash, signature: serverSig.signature },
    };
  }

  // Shared post-submit bookkeeping: stamp the queue row + order + day counters.
  _afterSubmit(row, data, receiptId, signature) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE fiscal_queue SET status = 'SUBMITTED', receipt_id = ?, server_signature = ?, submitted_at = ?, error = NULL WHERE id = ?`,
      )
      .run(receiptId, signature, now, row.id);
    this.db.prepare('UPDATE orders SET fiscal_receipt_id = ? WHERE id = ?').run(receiptId, row.order_id);
    const tenantId = String(row.tenant_id);
    const counters = this._addDayCounters(tenantId, row);
    this._setMeta(tenantId, 'fiscal.last_receipt_id', String(receiptId));
    this._setMeta(tenantId, 'fiscal.day.counters', JSON.stringify(counters));
  }

  _addDayCounters(tenantId, row) {
    const payload = JSON.parse(row.payload);
    const counters = JSON.parse(this._meta(tenantId, 'fiscal.day.counters', '{}') || '{}');
    for (const t of payload.dto.receiptTaxes || []) {
      const k = String(t.taxID);
      counters.tax = counters.tax || {};
      const c = counters.tax[k] || [0, 0];
      counters.tax[k] = [c[0] + Math.round(t.salesAmountWithTax * 100), c[1] + Math.round(t.taxAmount * 100)];
    }
    for (const p of payload.dto.receiptPayments || []) {
      counters.money = counters.money || {};
      counters.money[p.moneyTypeCode] = (counters.money[p.moneyTypeCode] || 0) + Math.round(p.paymentAmount * 100);
    }
    return counters;
  }

  // -- status ---------------------------------------------------------------
  status(user) {
    const tenantId = resolveTenantId(this.db, user?.tenantId);
    const cfg = this.config();
    const st = this._state(tenantId);
    const pending = this.db
      .prepare("SELECT COUNT(*) AS c FROM fiscal_queue WHERE tenant_id = ? AND status = 'PENDING'")
      .get(tenantId).c;
    const lastErr =
      this.db
        .prepare('SELECT error FROM fiscal_queue WHERE tenant_id = ? AND error IS NOT NULL ORDER BY id DESC LIMIT 1')
        .get(tenantId)?.error ?? null;
    return {
      enabled: cfg.enabled,
      mode: cfg.mode,
      baseUrl: cfg.baseUrl,
      deviceId: cfg.deviceId,
      serialNo: cfg.serialNo,
      modelName: cfg.modelName,
      modelVersion: cfg.modelVersion,
      registered: st.registered,
      dayNo: st.dayNo,
      receiptCounter: st.receiptCounter,
      globalNo: st.globalNo,
      pendingQueue: pending,
      lastError: lastErr,
      currency: cfg.currency,
      tin: cfg.tin,
    };
  }
}

// Build the CloseDay fiscalDayCounters array from the running day aggregate.
export function buildDayCounters(counters) {
  const out = [];
  for (const [taxID, [amountWithTax, tax]] of Object.entries(counters.tax || {})) {
    out.push({
      fiscalCounterType: 'SaleByTax',
      fiscalCounterCurrency: 'USD',
      fiscalCounterTaxID: Number(taxID),
      fiscalCounterValue: round2(amountWithTax / 100),
    });
    out.push({
      fiscalCounterType: 'SaleTaxByTax',
      fiscalCounterCurrency: 'USD',
      fiscalCounterTaxID: Number(taxID),
      fiscalCounterValue: round2(tax / 100),
    });
  }
  for (const [moneyType, amount] of Object.entries(counters.money || {})) {
    out.push({
      fiscalCounterType: 'BalanceByMoneyType',
      fiscalCounterCurrency: 'USD',
      fiscalCounterMoneyType: moneyType,
      fiscalCounterValue: round2(amount / 100),
    });
  }
  return out;
}

function round2(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

export default { FiscalService, buildEcdsaCsr, canonicalReceiptContent, signContent, verifySignature };
