import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { makeApp, seedCatalog, admin } from './helpers.js';
import { EcocashOpenApiProvider, EcocashLiveProvider, verifyEcoCashCallback } from '../src/services/ecocash.js';

// Local stub standing in for the EcoCash Open API sandbox. Captures the last
// request (method, path, auth header, body) so the provider's wire contract can
// be asserted, and returns whatever the caller schedules.
function stubServer(schedule) {
  const seen = [];
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const record = {
        method: req.method,
        path: req.url,
        auth: req.headers.authorization || '',
        headers: req.headers,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/\0+$/, '') || '{}') : null,
      };
      seen.push(record);
      const reply = schedule(req, record);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  return { srv, seen, url: null };
}

async function listen(server) {
  await new Promise((r) => server.srv.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.srv.address().port}`;
}

// Sandbox credentials come from the environment; the defaults are throwaway
// placeholders so the wire contract stays testable without real secrets in VCS.
const MERCHANT_CODE = process.env.ECOCASH_SANDBOX_MERCHANT_CODE || '287000';
const CREDS = {
  env: 'sandbox',
  username: process.env.ECOCASH_SANDBOX_USERNAME || 'sbx_test_user',
  password: process.env.ECOCASH_SANDBOX_PASSWORD || 'test-password',
  merchantCode: MERCHANT_CODE,
  merchantPin: '1234',
  merchantNumber: '778503033',
  notifyUrl: 'https://ngrok.example/webhook',
};

test('Open API provider: charge posts Basic auth + merchant fields, normalizes status', async () => {
  const stub = stubServer(() => ({
    status: 'PENDING',
    clientCorrelator: 'ECOCASH-REF-1',
    prompt: { msg: 'approve on phone' },
  }));
  const base = await listen(stub);
  const p = new EcocashOpenApiProvider({ baseUrl: base, ...CREDS });

  const out = await p.initiate({
    amountCents: 15180,
    phone: '0771234567',
    reference: 'ECOCASH-REF-1',
    currency: 'USD',
  });

  assert.equal(stub.seen.length, 1);
  const r = stub.seen[0];
  assert.equal(r.method, 'POST');
  assert.equal(r.path, '/api/sandbox/transactions/charges');
  assert.equal(r.auth, 'Basic ' + Buffer.from(`${CREDS.username}:${CREDS.password}`).toString('base64'));
  assert.equal(r.body.merchantCode, CREDS.merchantCode);
  assert.equal(r.body.merchantPin, '1234');
  assert.equal(r.body.merchantNumber, '778503033');
  assert.equal(r.body.endUserId, '0771234567');
  assert.equal(r.body.clientCorrelator, 'ECOCASH-REF-1');
  assert.equal(r.body.paymentAmount.charginginformation.amount, 151.8);
  assert.equal(r.body.notifyUrl, 'https://ngrok.example/webhook');

  assert.equal(out.status, 'PENDING');
  assert.equal(out.providerRef, 'ECOCASH-REF-1');
  assert.equal(out.prompt.msg, 'approve on phone');
  await new Promise((r) => stub.srv.close(r));
});

test('Open API provider: status and refund hit their paths with the original reference', async () => {
  const stub = stubServer(() => ({ transactionStatus: 'COMPLETED', ecocashReference: 'ECC-987654' }));
  const base = await listen(stub);
  const p = new EcocashOpenApiProvider({ baseUrl: base, ...CREDS });

  const st = await p.status({ reference: 'ECOCASH-REF-1', phone: '0771234567' });
  assert.equal(stub.seen[0].method, 'GET');
  assert.equal(stub.seen[0].path, '/api/sandbox/0771234567/transactions/amount/ECOCASH-REF-1');
  assert.equal(st.status, 'COMPLETED');
  assert.equal(st.providerRef, 'ECC-987654');

  const rf = await p.refund({
    amountCents: 5175,
    phone: '0771234567',
    reference: 'ECOCASH-REF-2',
    currency: 'USD',
    originalRef: 'ECC-987654',
  });
  const rr = stub.seen[1];
  assert.equal(rr.method, 'POST');
  assert.equal(rr.path, '/api/sandbox/transactions/refund');
  assert.equal(rr.body.tranType, 'REF');
  assert.equal(rr.body.originalEcocashReference, 'ECC-987654');
  assert.equal(rf.providerRef, 'ECC-987654');
  assert.equal(rf.status, 'COMPLETED');
  await new Promise((r) => stub.srv.close(r));
});

test('Open API provider: upstream 4xx/5xx surfaces as ECOCASH_UPSTREAM', async () => {
  const srv = createServer((_req, res) =>
    res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'Bad credentials' })),
  );
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = new EcocashOpenApiProvider({ baseUrl: `http://127.0.0.1:${srv.address().port}`, ...CREDS });
  await assert.rejects(p.initiate({ amountCents: 1000, phone: '0771234567', reference: 'R', currency: 'USD' }), (e) =>
    e.message.startsWith('ECOCASH_UPSTREAM 401'),
  );
  await new Promise((r) => srv.close(r));
});

test('service: sandbox mode with username config picks the Open API provider over the apiKey provider', async () => {
  const stub = stubServer(() => ({ status: 'PENDING', clientCorrelator: 'X' }));
  const base = await listen(stub);
  const app = makeApp();
  const ups = app.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries({
    'ecocash.enabled': '1',
    'ecocash.mode': 'sandbox',
    'ecocash.base_url': base,
    'ecocash.username': CREDS.username,
    'ecocash.password': CREDS.password,
    'ecocash.merchant_pin': CREDS.merchantPin,
    'ecocash.merchant_number': CREDS.merchantNumber,
    'ecocash.merchant_code': CREDS.merchantCode,
  }))
    ups.run(k, v);

  const { A } = seedCatalog(app);
  const res = await app.pos.ecocashInitiate({
    items: [{ productId: A.id, qty: 1 }],
    payments: [{ method: 'ECOCASH', amount: 5175 }],
    phone: '0771234567',
    user: admin(app),
  });

  assert.equal(res.status, 'AWAITING_PAYMENT');
  assert.equal(res.ecocash_status, 'PENDING');
  assert.equal(stub.seen.length, 1);
  assert.equal(stub.seen[0].path, '/api/sandbox/transactions/charges');
  assert.ok(stub.seen[0].auth.startsWith('Basic '));
  const txn = app.eco.byReference(res.eco.reference);
  assert.equal(txn.provider, 'SANDBOX');
  await new Promise((r) => stub.srv.close(r));
});

test('callback trust: sandbox without a key accepts unsigned; live and keyed-sandbox reject', async () => {
  assert.equal(verifyEcoCashCallback({ publicKey: '', rawBody: '{}', signature: '', mode: 'sandbox' }), true);
  assert.equal(verifyEcoCashCallback({ publicKey: 'secret', rawBody: '{}', signature: '', mode: 'sandbox' }), false);
  assert.equal(verifyEcoCashCallback({ publicKey: '', rawBody: '{}', signature: '', mode: 'live' }), false);
  assert.equal(verifyEcoCashCallback({ publicKey: '', rawBody: '{}', signature: '', mode: 'simulator' }), true);
});

// ---- X-API-KEY v2 provider (developers.ecocash.co.zw/api/ecocash_pay) ----
// Wire contract pinned against the SDKs that actually work against the portal.

const V2_BASE = 'https://developers.ecocash.co.zw/api/ecocash_pay';
const V2_KEY = 'test-sandbox-api-key';
const V2_CREDS = { env: 'sandbox', merchantCode: MERCHANT_CODE, apiKey: V2_KEY };

test('live provider: initiate posts X-API-KEY + Merchant headers and the v2 C2B body to the sandbox path', async () => {
  const stub = stubServer(() => ({ status: 'PENDING', sourceReference: 'ECOCASH-REF-1' }));
  const base = await listen(stub);
  const p = new EcocashLiveProvider({ ...V2_CREDS, baseUrl: base });

  const out = await p.initiate({
    amountCents: 15180,
    phone: '0771234567',
    reference: 'ECOCASH-REF-1',
    currency: 'USD',
  });

  assert.equal(stub.seen.length, 1);
  const r = stub.seen[0];
  assert.equal(r.method, 'POST');
  assert.equal(r.path, '/api/v2/payment/instant/c2b/sandbox');
  assert.equal(r.auth, '');
  assert.equal(r.headers['x-api-key'], V2_KEY);
  assert.equal(r.headers.merchant, MERCHANT_CODE);
  assert.equal(r.body.customerMsisdn, '0771234567');
  assert.equal(r.body.phone, '0771234567');
  assert.equal(r.body.amount, 151.8);
  assert.equal(r.body.currency, 'USD');
  assert.equal(r.body.sourceReference, 'ECOCASH-REF-1');
  assert.ok(r.body.reason);

  assert.equal(out.status, 'PENDING');
  assert.equal(out.providerRef, 'ECOCASH-REF-1');
  await new Promise((r) => stub.srv.close(r));
});

test('live provider: status polls POST /api/v1/transaction/c2b/status and maps SUCCESS/COMPLETED', async () => {
  const stub = stubServer((req) => {
    const r = { status: 'SUCCESS', transactionId: 'ECC-987654' };
    r.was = req.method + ' ' + req.url;
    return r;
  });
  const base = await listen(stub);
  const p = new EcocashLiveProvider({ ...V2_CREDS, baseUrl: base });

  const st = await p.status({ reference: 'ECOCASH-REF-1', phone: '0771234567' });
  const r = stub.seen[0];
  assert.equal(r.path, '/api/v1/transaction/c2b/status/sandbox');
  assert.equal(r.body.sourceMobileNumber, '0771234567');
  assert.equal(r.body.sourceReference, 'ECOCASH-REF-1');
  assert.equal(st.status, 'COMPLETED');
  assert.equal(st.providerRef, 'ECC-987654');
  await new Promise((r) => stub.srv.close(r));
});

test('live provider: refund posts the v2 refund body including the original reference', async () => {
  const stub = stubServer(() => ({ status: 'PENDING', transactionId: 'R-1' }));
  const base = await listen(stub);
  const p = new EcocashLiveProvider({ ...V2_CREDS, baseUrl: base });

  const rf = await p.refund({
    amountCents: 5175,
    phone: '0771234567',
    reference: 'ECOCASH-REF-2',
    currency: 'USD',
    originalRef: 'ECC-987654',
  });
  const r = stub.seen[0];
  assert.equal(r.path, '/api/v2/refund/instant/c2b/sandbox');
  assert.equal(r.body.origionalEcocashTransactionReference, 'ECC-987654');
  assert.equal(r.body.refundCorelator, 'ECOCASH-REF-2');
  assert.equal(r.body.sourceMobileNumber, '0771234567');
  assert.equal(r.body.amount, 51.75);
  assert.ok(r.body.reasonForRefund);
  assert.equal(rf.status, 'PENDING');
  await new Promise((r) => stub.srv.close(r));
});

test('live provider: upstream 4xx surfaces as ECOCASH_UPSTREAM', async () => {
  const srv = createServer((_req, res) =>
    res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'Forbidden' })),
  );
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = new EcocashLiveProvider({ ...V2_CREDS, baseUrl: `http://127.0.0.1:${srv.address().port}` });
  await assert.rejects(p.initiate({ amountCents: 1000, phone: '0771234567', reference: 'R', currency: 'USD' }), (e) =>
    e.message.startsWith('ECOCASH_UPSTREAM 403'),
  );
  await new Promise((r) => srv.close(r));
});

test('service: sandbox mode with apiKey picks the v2 provider; default base points at the portal', async () => {
  const stub = stubServer(() => ({ status: 'SUCCESS', transactionId: 'TX-V2' }));
  const base = await listen(stub);
  const app = makeApp();
  const ups = app.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries({
    'ecocash.enabled': '1',
    'ecocash.mode': 'sandbox',
    'ecocash.base_url': base,
    'ecocash.merchant_code': MERCHANT_CODE,
    'ecocash.api_key': V2_KEY,
  }))
    ups.run(k, v);

  const { A } = seedCatalog(app);
  const res = await app.pos.ecocashInitiate({
    items: [{ productId: A.id, qty: 1 }],
    payments: [{ method: 'ECOCASH', amount: 5175 }],
    phone: '0771234567',
    user: admin(app),
  });

  assert.equal(res.status, 'AWAITING_PAYMENT');
  assert.equal(res.ecocash_status, 'PENDING');
  assert.equal(stub.seen.length, 1);
  assert.equal(stub.seen[0].path, '/api/v2/payment/instant/c2b/sandbox');
  assert.equal(stub.seen[0].headers['x-api-key'], V2_KEY);
  const txn = app.eco.byReference(res.eco.reference);
  assert.equal(txn.provider, 'SANDBOX');
  await new Promise((r) => stub.srv.close(r));
});

test('live provider: default base URL is the portal api/ecocash_pay prefix', () => {
  const p = new EcocashLiveProvider({ env: 'sandbox', merchantCode: MERCHANT_CODE, apiKey: V2_KEY });
  assert.equal(p.baseUrl, V2_BASE);
});
