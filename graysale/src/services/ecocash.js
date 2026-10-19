import { randomUUID, createHmac, createVerify, timingSafeEqual } from 'node:crypto';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { nowLocal } from '../lib/ids.js';
import { resolveTenantId } from '../lib/tenant.js';

// ---------------------------------------------------------------- providers

// Our idempotency key. Every C2B attempt carries a unique sourceReference so a
// retried initiate or a replayed callback can never double-settle a sale.
export function makeEcoCashReference() {
  return `ECOCASH-${Date.now()}-${randomUUID().slice(0, 8)}`.toUpperCase();
}

const NORMALIZE_STATUS = {
  COMPLETED: 'COMPLETED',
  SUCCESS: 'COMPLETED',
  PENDING_VALIDATION: 'PENDING',
  PENDING_CONFIRMATION: 'PENDING',
  PENDING: 'PENDING',
  PROCESSING: 'PENDING',
  AWAITING_USER_INPUT: 'PENDING',
  FAILED: 'FAILED',
  CANCELLED: 'FAILED',
  TIMED_OUT: 'FAILED',
  EXPIRED: 'FAILED',
  REVERSED: 'FAILED',
};

// Local loopback provider used whenever EcoCash isn't wired to a real sandbox
// or live account. It exercises the exact same C2B lifecycle (initiate ->
// PENDING -> customer approves -> COMPLETED) that the real API follows; the
// "customer approval" is delivered through the webhook route, which keeps the
// HMAC/RSA verification and idempotency paths honest in tests and demos.
class SimulatorProvider {
  async initiate({ amountCents, currency }) {
    return {
      providerRef: `SIM-${randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()}`,
      status: 'PENDING',
      prompt: {
        label: 'Simulator C2B request created. Deliver POST /ecocash/webhook to settle.',
        amount: amountCents / 100,
        currency,
      },
    };
  }

  async status() {
    return { status: 'PENDING' };
  }

  async refund() {
    return {
      providerRef: `SIMR-${randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()}`,
      status: 'PENDING',
    };
  }
}

// Real EcoCash Open API client (developers.ecocash.co.zw). This is the current
// generation that the marketplace SDKs (phoscoder/ecocash npm, iamngoni/ecocash
// Dart, the official v2 hackathon samples) all use successfully: header
// X-API-KEY + Merchant code, not Basic auth. Field names follow the proven v2
// "instant C2B" wire contract; status is polled via POST
// /api/v1/transaction/c2b/status until the transaction reports SUCCESS.
export class EcocashLiveProvider {
  constructor({ env, baseUrl, merchantCode, apiKey }) {
    this.env = env; // sandbox | live
    this.baseUrl = (baseUrl || 'https://developers.ecocash.co.zw/api/ecocash_pay').replace(/\/$/, '');
    this.merchantCode = merchantCode;
    this.apiKey = apiKey;
  }

  async _post(path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-API-KEY': this.apiKey,
        Merchant: this.merchantCode,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
      throw conflict(
        `ECOCASH_UPSTREAM ${res.status}: ${data && (data.message || data.description || JSON.stringify(data)).slice(0, 200)}`,
      );
    return data;
  }

  async initiate({ amountCents, phone, reference, currency, reason = 'Payment' }) {
    const data = await this._post(`/api/v2/payment/instant/c2b/${this.env}`, {
      customerMsisdn: phone,
      phone,
      amount: amountCents / 100,
      reason,
      currency,
      sourceReference: reference,
    });
    return {
      providerRef: data.transactionId || data.sourceReference || reference,
      status: NORMALIZE_STATUS[data.status || 'PENDING'] || 'PENDING',
      prompt: data.prompt || {},
    };
  }

  async status({ reference, phone }) {
    const data = await this._post(`/api/v1/transaction/c2b/status/${this.env}`, {
      sourceMobileNumber: phone,
      sourceReference: reference,
    });
    return {
      providerRef: data.transactionId || data.ecocashTransactionReference || reference,
      status: NORMALIZE_STATUS[data.status || 'PENDING'] || 'PENDING',
    };
  }

  async refund({ amountCents, phone, reference, currency, originalRef, reason = 'Refund' }) {
    const data = await this._post(`/api/v2/refund/instant/c2b/${this.env}`, {
      origionalEcocashTransactionReference: originalRef,
      refundCorelator: reference,
      sourceMobileNumber: phone,
      amount: amountCents / 100,
      clientName: 'graysale',
      currency,
      reasonForRefund: reason,
    });
    return {
      providerRef: data.transactionId || data.ecocashTransactionReference || reference,
      status: NORMALIZE_STATUS[data.status || 'PENDING'] || 'PENDING',
    };
  }
}

// EcoCash Open API (developer.ecocash.co.zw, Basic auth). This is the
// "Online API" generation: Authorization: Basic base64(username:password),
// merchant number + code + PIN in the JSON body, endpoints under
// /api/{sandbox|live}/transactions/charges. Different wire contract from the
// apiKey-header Econet v2 API above, so it lives as a separate provider. Exact
// response field names are validated against the live sandbox on first connect.
export class EcocashOpenApiProvider {
  constructor({
    env,
    baseUrl,
    username,
    password,
    merchantCode,
    merchantPin,
    merchantNumber,
    notifyUrl,
    currency,
    country = 'ZW',
  }) {
    this.env = env; // sandbox | live
    this.baseUrl = (baseUrl || '').replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this.merchantCode = merchantCode;
    this.merchantPin = merchantPin;
    this.merchantNumber = merchantNumber;
    this.notifyUrl = notifyUrl || '';
    this.currency = currency || 'USD';
    this.country = country;
  }

  _auth() {
    return 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
  }

  async _send(method, path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: this._auth() },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
      throw conflict(
        `ECOCASH_UPSTREAM ${res.status}: ${data && (data.message || data.description || data.errorDescription || JSON.stringify(data)).slice(0, 200)}`,
      );
    return data;
  }

  // Map whatever the sandbox reports onto our lifecycle statuses.
  _normalize(data, fallback = 'PENDING') {
    const s = String(data.status || data.transactionStatus || data.state || data.resultCode || fallback).toUpperCase();
    return NORMALIZE_STATUS[s] || fallback;
  }

  _ref(data) {
    return data.ecocashReference || data.transactionId || data.reference || data.clientCorrelator || data.id || null;
  }

  _merchant() {
    return {
      merchantCode: this.merchantCode,
      merchantPin: this.merchantPin,
      merchantNumber: this.merchantNumber,
      currencyCode: this.currency,
      countryCode: this.country,
    };
  }

  async initiate({ amountCents, phone, reference, currency }) {
    const data = await this._send('POST', `/api/${this.env}/transactions/charges`, {
      clientCorrelator: reference,
      referenceCode: reference,
      tranType: 'MER',
      endUserId: phone,
      remarks: 'Online payment',
      transactionOperationStatus: 'CHARGED',
      notifyUrl: this.notifyUrl || undefined,
      paymentAmount: {
        charginginformation: {
          amount: amountCents / 100,
          currency: currency || this.currency,
          description: 'C2B payment',
        },
        chargeMetaData: { channel: 'WEB', purchaseCategoryCode: 'Mobile Money' },
      },
      ...this._merchant(),
    });
    return {
      providerRef: this._ref(data) || reference,
      status: this._normalize(data),
      prompt: data.prompt || (data.SandboxExecutionView ? { send: data.SandboxExecutionView } : {}),
    };
  }

  async status({ reference, phone }) {
    const data = await this._send('GET', `/api/${this.env}/${phone}/transactions/amount/${reference}`);
    return {
      providerRef: this._ref(data) || reference,
      status: this._normalize(data),
    };
  }

  async refund({ amountCents, phone, reference, currency, originalRef }) {
    const data = await this._send('POST', `/api/${this.env}/transactions/refund`, {
      clientCorrelator: reference,
      referenceCode: reference,
      tranType: 'REF',
      endUserId: phone,
      originalEcocashReference: originalRef || undefined,
      remark: 'Refund',
      transactionOperationStatus: 'REFUNDED',
      paymentAmount: {
        charginginformation: { amount: amountCents / 100, currency: currency || this.currency, description: 'Refund' },
        chargeMetaData: { channel: 'SMS', purchaseCategoryCode: 'Mobile Money' },
      },
      ...this._merchant(),
    });
    return {
      providerRef: this._ref(data) || reference,
      status: this._normalize(data),
    };
  }
}

// Verify an EcoCash callback signature over the raw request body.
//   * publicKey PEM present    -> RSA-SHA256 (base64) with the balance's public key
//   * plain shared secret      -> HMAC-SHA256
//   * nothing configured       -> simulator/sandbox mode: unsigned callbacks are trusted
//                                (sandbox dev convenience until the signer contract is known; live stays strict)
export function verifyEcoCashCallback({ publicKey, rawBody, signature, mode = '' }) {
  if (!signature) return ['simulator', 'sandbox'].includes(String(mode).toLowerCase()) && !publicKey;
  if (publicKey && publicKey.includes('-----BEGIN')) {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(rawBody);
    return verifier.verify(publicKey, Buffer.from(signature, 'base64'));
  }
  // No shared secret configured — never trust a signed claim (simulator callbacks are unsigned).
  if (!publicKey) return false;
  const expected = createHmac('sha256', publicKey).update(rawBody).digest('base64');
  const given = Buffer.from(signature, 'base64');
  const exp = Buffer.from(expected, 'base64');
  return given.length === exp.length && given.length > 0 && timingSafeEqual(given, exp);
}

// ---------------------------------------------------------------- service

export class EcoCashService {
  constructor({ db }) {
    this.db = db;
  }

  config() {
    const g = (k, def = '') => this.db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? def;
    return {
      enabled: g('ecocash.enabled') === '1',
      mode: g('ecocash.mode', 'simulator'),
      merchantCode: g('ecocash.merchant_code'),
      apiKey: g('ecocash.api_key'),
      baseUrl: g('ecocash.base_url'),
      publicKey: g('ecocash.public_key'),
      currency: g('ecocash.currency', 'USD'),
      username: g('ecocash.username'),
      password: g('ecocash.password'),
      merchantPin: g('ecocash.merchant_pin'),
      merchantNumber: g('ecocash.merchant_number'),
      notifyUrl: g('ecocash.notify_url'),
    };
  }

  _provider(cfg) {
    if (cfg.mode === 'sandbox' || cfg.mode === 'live') {
      // The X-API-KEY v2 generation (developers.ecocash.co.zw/api/ecocash_pay)
      // is the current one every working SDK uses. The Basic-auth Open API is
      // the legacy generation, kept only as a fallback for users who have not
      // yet provisioned an API key in the portal.
      if (cfg.merchantCode && cfg.apiKey) {
        return new EcocashLiveProvider({
          env: cfg.mode,
          baseUrl: cfg.baseUrl,
          merchantCode: cfg.merchantCode,
          apiKey: cfg.apiKey,
        });
      }
      if (cfg.username && cfg.password && cfg.merchantCode && cfg.merchantNumber) {
        return new EcocashOpenApiProvider({
          env: cfg.mode,
          baseUrl: cfg.baseUrl,
          username: cfg.username,
          password: cfg.password,
          merchantCode: cfg.merchantCode,
          merchantPin: cfg.merchantPin,
          merchantNumber: cfg.merchantNumber,
          notifyUrl: cfg.notifyUrl,
          currency: cfg.currency,
        });
      }
      throw conflict('ECOCASH_NOT_CONFIGURED: set merchant code + API key (or username + merchant number) in Settings');
    }
    return new SimulatorProvider();
  }

  _insert(txn) {
    const { lastInsertRowid } = this.db
      .prepare(
        `
      INSERT INTO ecocash_transactions (tenant_id, order_id, kind, provider, status, reference, provider_ref, amount_cents, phone, currency, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        txn.tenantId,
        txn.orderId ?? null,
        txn.kind,
        txn.provider,
        txn.status,
        txn.reference,
        txn.providerRef ?? null,
        txn.amountCents,
        txn.phone ?? '',
        txn.currency,
        txn.meta ? JSON.stringify(txn.meta) : null,
      );
    return this.byId(lastInsertRowid);
  }

  byId(id) {
    return this.db.prepare('SELECT * FROM ecocash_transactions WHERE id = ?').get(id);
  }

  byReference(reference) {
    return this.db.prepare('SELECT * FROM ecocash_transactions WHERE reference = ?').get(reference);
  }

  byOrder(orderId, kind) {
    return this.db
      .prepare('SELECT * FROM ecocash_transactions WHERE order_id = ? AND kind = ? ORDER BY id DESC LIMIT 1')
      .get(orderId, kind);
  }

  _setStatus(id, status, extra = {}) {
    const fields = { status, updated_at: nowLocal() };
    if (extra.providerRef) fields.provider_ref = extra.providerRef;
    if (extra.meta) fields.meta = JSON.stringify(extra.meta);
    const sets = Object.keys(fields)
      .map((k) => `${k} = ?`)
      .join(', ');
    this.db.prepare(`UPDATE ecocash_transactions SET ${sets} WHERE id = ?`).run(...Object.values(fields), id);
    return this.byId(id);
  }

  // Start a C2B request: persist a PENDING row first, then hand the phone to
  // the provider. The reference is our sourceReference (idempotency key).
  async initiateTxn({ orderId, kind = 'C2B_PAYMENT', amountCents, phone, currency, user }) {
    const tenantId = resolveTenantId(this.db, user?.tenantId);
    const cfg = this.config();
    if (!cfg.enabled && kind === 'C2B_PAYMENT') throw conflict('ECOCASH_DISABLED');
    if (!phone || !String(phone).trim()) throw badRequest('ECO_PHONE_REQUIRED');
    if (amountCents <= 0) throw badRequest('ECO_AMOUNT_INVALID');
    const reference = makeEcoCashReference();
    const txn = this._insert({
      tenantId,
      orderId,
      kind,
      provider: cfg.mode.toUpperCase(),
      status: 'PENDING',
      reference,
      providerRef: null,
      amountCents,
      phone,
      currency: currency || cfg.currency,
    });
    const provider = this._provider(cfg);
    const res = await provider.initiate({ amountCents, phone, reference, currency: txn.currency });
    return {
      txn: this._setStatus(txn.id, res.status === 'COMPLETED' ? 'COMPLETED' : 'PENDING', {
        providerRef: res.providerRef,
        meta: { prompt: res.prompt },
      }),
      cfg,
    };
  }

  // Poll the provider for a still-pending txn (live mode). Simulator never
  // settles on its own, so it stays PENDING until a callback arrives.
  async poll(orderId) {
    const txn = this.byOrder(orderId, 'C2B_PAYMENT');
    if (!txn) throw notFound('ECO_TXN_NOT_FOUND');
    if (txn.status !== 'PENDING') return txn;
    const cfg = this.config();
    if (cfg.mode === 'simulator') return txn;
    const provider = this._provider(cfg);
    const res = await provider.status({ reference: txn.reference, phone: txn.phone });
    if (res.status === 'COMPLETED' || res.status === 'FAILED') {
      return this._setStatus(txn.id, res.status, { providerRef: res.providerRef });
    }
    return txn;
  }

  // Handle a provider callback (webhook route). Verifies the signature, then
  // stamps the txn. Returns the txn for the POS layer to finalize. Replays are
  // idempotent: already-terminal txns are returned untouched.
  async callback({ reference, status, amountCents, providerRef, rawBody, signature }) {
    const cfg = this.config();
    if (!verifyEcoCashCallback({ publicKey: cfg.publicKey, rawBody, signature, mode: cfg.mode })) {
      throw conflict('ECO_CALLBACK_SIGNATURE_INVALID');
    }
    const txn = this.byReference(reference);
    if (!txn) throw notFound('ECO_TXN_NOT_FOUND');
    if (txn.status !== 'PENDING') return txn;
    const settled = (status || '').toUpperCase();
    if (settled === 'COMPLETED' || settled === 'SUCCESS') {
      // Amount is authoritative: an omitted or wrong amount never settles.
      const got = amountCents != null ? Math.round(Number(amountCents)) : undefined;
      if (got === undefined || got !== txn.amount_cents) {
        throw badRequest(`ECO_AMOUNT_MISMATCH: expected ${txn.amount_cents}, got ${got}`);
      }
      return this._setStatus(txn.id, 'COMPLETED', { providerRef: providerRef || txn.provider_ref });
    }
    if (settled === 'FAILED' || settled === 'CANCELLED' || settled === 'TIMED_OUT' || settled === 'EXPIRED') {
      return this._setStatus(txn.id, 'FAILED', {
        meta: { failure: settled },
        providerRef: providerRef || txn.provider_ref,
      });
    }
    return txn;
  }

  // Start a refund through an existing sale's C2B (provider initiates a payout).
  async refundTxn({ saleId, amountCents, phone, user }) {
    const tenantId = resolveTenantId(this.db, user?.tenantId);
    const cfg = this.config();
    const provider = this._provider(cfg);
    const original = this.byOrder(saleId, 'C2B_PAYMENT');
    const reference = makeEcoCashReference();
    const txn = this._insert({
      tenantId,
      orderId: saleId,
      kind: 'C2B_REFUND',
      provider: cfg.mode.toUpperCase(),
      status: 'PENDING',
      reference,
      providerRef: null,
      amountCents,
      phone: phone || '',
      currency: cfg.currency,
      meta: { original: original?.provider_ref || null },
    });
    const res = await provider.refund({
      amountCents,
      phone,
      reference,
      currency: txn.currency,
      originalRef: original?.provider_ref,
    });
    return this._setStatus(txn.id, res.status === 'COMPLETED' ? 'COMPLETED' : 'PENDING', {
      providerRef: res.providerRef,
    });
  }

  cancelOrder(orderId) {
    const txn = this.byOrder(orderId, 'C2B_PAYMENT');
    if (!txn) throw notFound('ECO_TXN_NOT_FOUND');
    if (txn.status !== 'PENDING') throw conflict('ECO_TXN_NOT_PENDING');
    return this._setStatus(txn.id, 'CANCELLED');
  }
}

export default {
  EcoCashService,
  EcocashOpenApiProvider,
  EcocashLiveProvider,
  verifyEcoCashCallback,
  makeEcoCashReference,
};
