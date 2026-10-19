import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';

const ECO_MODES = [
  { value: 'simulator', label: 'Simulator (offline demo)' },
  { value: 'sandbox', label: 'Sandbox (EcoCash developer test)' },
  { value: 'live', label: 'Live (production)' },
];

const FDMS_MODES = [
  { value: 'simulator', label: 'Simulator (offline, self-signed device)' },
  { value: 'live', label: 'Live (fdmsapi.zimra.co.zw)' },
];

const FLAT_KEYS = [
  'ecocashEnabled',
  'ecocashMode',
  'ecocashMerchantCode',
  'ecocashApiKey',
  'ecocashBaseUrl',
  'ecocashPublicKey',
  'ecocashCurrency',
  'ecocashUsername',
  'ecocashPassword',
  'ecocashMerchantPin',
  'ecocashMerchantNumber',
  'ecocashNotifyUrl',
  'fdmsEnabled',
  'fdmsMode',
  'fdmsBaseUrl',
  'fdmsDeviceId',
  'fdmsSerialNo',
  'fdmsActivationKey',
  'fdmsModelName',
  'fdmsModelVersion',
  'fdmsTin',
  'fdmsCurrency',
  'fdmsWorkstation',
];

function fromApi(s) {
  const eco = s?.ecocash || {};
  const fdms = s?.fdms || {};
  return {
    ecocashEnabled: !!eco.enabled,
    ecocashMode: eco.mode || 'simulator',
    ecocashMerchantCode: eco.merchantCode || '',
    ecocashApiKey: eco.apiKey || '',
    ecocashBaseUrl: eco.baseUrl || '',
    ecocashPublicKey: '',
    ecocashCurrency: eco.currency || 'USD',
    ecocashUsername: eco.username || '',
    ecocashPassword: '',
    ecocashMerchantPin: '',
    ecocashMerchantNumber: eco.merchantNumber || '',
    ecocashNotifyUrl: eco.notifyUrl || '',
    fdmsEnabled: !!fdms.enabled,
    fdmsMode: fdms.mode || 'simulator',
    fdmsBaseUrl: fdms.baseUrl || 'https://fdmsapi.zimra.co.zw',
    fdmsDeviceId: fdms.deviceId || '',
    fdmsSerialNo: fdms.serialNo || '',
    fdmsActivationKey: fdms.activationKey || '',
    fdmsModelName: fdms.modelName || '',
    fdmsModelVersion: fdms.modelVersion || '',
    fdmsTin: fdms.tin || '',
    fdmsCurrency: fdms.currency || 'USD',
    fdmsWorkstation: fdms.workstation || '',
  };
}

export default function IntegrationsPanel() {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [initial, setInitial] = useState({});
  const [publicKeySet, setPublicKeySet] = useState(false);
  const [passwordSet, setPasswordSet] = useState(false);
  const [merchantPinSet, setMerchantPinSet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fiscal, setFiscal] = useState(null);
  const [busy, setBusy] = useState('');

  const loadSettings = async () => {
    try {
      const s = await api.get('/settings');
      const flat = fromApi(s);
      setForm(flat);
      setInitial(flat);
      setPublicKeySet(!!s?.ecocash?.publicKeySet);
      setPasswordSet(!!s?.ecocash?.passwordSet);
      setMerchantPinSet(!!s?.ecocash?.merchantPinSet);
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    }
  };

  const loadFiscal = async () => {
    try {
      setFiscal(await api.get('/pos/fiscal/status'));
    } catch (e) {
      if (e?.silent) return;
    }
  };

  useEffect(() => {
    loadSettings();
    loadFiscal();
  }, []);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const body = {};
    for (const k of FLAT_KEYS) {
      if (['ecocashPublicKey', 'ecocashPassword', 'ecocashMerchantPin'].includes(k) && !String(form[k] || '').trim())
        continue;
      if (form[k] !== initial[k]) body[k] = form[k];
    }
    if (!Object.keys(body).length) {
      toast.ok('No integration settings changed');
      return;
    }
    setSaving(true);
    try {
      await api.post('/settings', body);
      toast.ok('Integration settings saved');
      await loadSettings();
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    } finally {
      setSaving(false);
    }
  };

  const runFiscal = async (action, label, verb) => {
    setBusy(action);
    try {
      const r = await api.post(`/pos/fiscal/${verb}`);
      toast.ok(label + (r?.ok === false ? ` — ${r.error}` : ''));
      await loadFiscal();
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    } finally {
      setBusy('');
    }
  };

  const fs = (k, def = '') => (fiscal && fiscal[k] != null ? fiscal[k] : def);

  return (
    <div className="panel mt-4">
      <div className="panel-hd">
        <span>Payments &amp; fiscal integrations</span>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save integrations'}
        </button>
      </div>

      <div className="form-grid">
        <div className="field">
          <label>EcoCash enabled</label>
          <select
            value={form.ecocashEnabled ? '1' : '0'}
            onChange={(e) => set('ecocashEnabled', e.target.value === '1')}
          >
            <option value="0">Disabled</option>
            <option value="1">Enabled</option>
          </select>
        </div>
        <div className="field">
          <label>EcoCash mode</label>
          <select value={form.ecocashMode} onChange={(e) => set('ecocashMode', e.target.value)}>
            {ECO_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Merchant code</label>
          <input
            value={form.ecocashMerchantCode}
            onChange={(e) => set('ecocashMerchantCode', e.target.value)}
            placeholder="e.g. 782319"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label>API key</label>
          <input
            type="password"
            value={form.ecocashApiKey}
            onChange={(e) => set('ecocashApiKey', e.target.value)}
            placeholder="Issued by EcoCash developer portal"
            autoComplete="new-password"
          />
        </div>
        <div className="field">
          <label>Open API username</label>
          <input
            value={form.ecocashUsername}
            onChange={(e) => set('ecocashUsername', e.target.value)}
            placeholder="sbx_… sandbox account"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label>
            Open API password{' '}
            {passwordSet ? (
              <span className="badge badge-green">set</span>
            ) : (
              <span className="badge badge-gray">not set</span>
            )}
          </label>
          <input
            type="password"
            value={form.ecocashPassword}
            onChange={(e) => set('ecocashPassword', e.target.value)}
            placeholder="Leave blank to keep the stored password"
            autoComplete="new-password"
          />
        </div>
        <div className="field">
          <label>
            Merchant PIN{' '}
            {merchantPinSet ? (
              <span className="badge badge-green">set</span>
            ) : (
              <span className="badge badge-gray">not set</span>
            )}
          </label>
          <input
            type="password"
            value={form.ecocashMerchantPin}
            onChange={(e) => set('ecocashMerchantPin', e.target.value)}
            placeholder="Leave blank to keep the stored PIN"
            autoComplete="new-password"
          />
        </div>
        <div className="field">
          <label>Merchant number</label>
          <input
            value={form.ecocashMerchantNumber}
            onChange={(e) => set('ecocashMerchantNumber', e.target.value)}
            placeholder="e.g. 778503033"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label>Notify URL</label>
          <input
            value={form.ecocashNotifyUrl}
            onChange={(e) => set('ecocashNotifyUrl', e.target.value)}
            placeholder="Public callback URL EcoCash will POST to (ngrok in dev)"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label>Base URL</label>
          <input
            value={form.ecocashBaseUrl}
            onChange={(e) => set('ecocashBaseUrl', e.target.value)}
            placeholder="https://api.econet.co.zw"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label>Currency</label>
          <input
            value={form.ecocashCurrency}
            onChange={(e) => set('ecocashCurrency', e.target.value)}
            placeholder="USD"
            autoComplete="off"
            maxLength={3}
          />
        </div>
      </div>
      <div className="field mt-3">
        <label>
          Webhook signature public key{' '}
          {publicKeySet ? (
            <span className="badge badge-green">set</span>
          ) : (
            <span className="badge badge-gray">not set</span>
          )}
        </label>
        <textarea
          rows={4}
          className="mono"
          value={form.ecocashPublicKey}
          onChange={(e) => set('ecocashPublicKey', e.target.value)}
          placeholder="Paste the RSA PEM or shared secret used to verify /ecocash/webhook callbacks. Leave empty to keep the existing key."
        />
      </div>
      <p className="hint mt-3">
        C2B mobile-money payments go through the two-phase flow: the till prompts the customer&rsquo;s phone, and the
        sale settles only when EcoCash callbacks confirm it. In Simulator mode POST{' '}
        <span className="mono">/ecocash/webhook</span> settles the sale.
      </p>

      <div className="mt-4">
        <div className="panel-hd">
          <span>ZIMRA FDMS — fiscal receipts</span>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>FDMS enabled</label>
            <select value={form.fdmsEnabled ? '1' : '0'} onChange={(e) => set('fdmsEnabled', e.target.value === '1')}>
              <option value="0">Disabled</option>
              <option value="1">Enabled</option>
            </select>
          </div>
          <div className="field">
            <label>FDMS mode</label>
            <select value={form.fdmsMode} onChange={(e) => set('fdmsMode', e.target.value)}>
              {FDMS_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Device ID</label>
            <input
              value={form.fdmsDeviceId}
              onChange={(e) => set('fdmsDeviceId', e.target.value)}
              placeholder="ZIMRA assigned device ID"
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label>Serial number</label>
            <input
              value={form.fdmsSerialNo}
              onChange={(e) => set('fdmsSerialNo', e.target.value)}
              placeholder="Device serial from ZIMRA"
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label>TIN</label>
            <input
              value={form.fdmsTin}
              onChange={(e) => set('fdmsTin', e.target.value)}
              placeholder="Taxpayer identification number"
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label>Activation key</label>
            <input
              type="password"
              value={form.fdmsActivationKey}
              onChange={(e) => set('fdmsActivationKey', e.target.value)}
              placeholder="Live device activation key"
              autoComplete="new-password"
            />
          </div>
          <div className="field">
            <label>Model name</label>
            <input
              value={form.fdmsModelName}
              onChange={(e) => set('fdmsModelName', e.target.value)}
              placeholder="e.g. GS-R1"
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label>Model version</label>
            <input
              value={form.fdmsModelVersion}
              onChange={(e) => set('fdmsModelVersion', e.target.value)}
              placeholder="e.g. 1.0.0"
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label>Currency</label>
            <input
              value={form.fdmsCurrency}
              onChange={(e) => set('fdmsCurrency', e.target.value)}
              placeholder="USD"
              autoComplete="off"
              maxLength={3}
            />
          </div>
          <div className="field">
            <label>Base URL</label>
            <input
              value={form.fdmsBaseUrl}
              onChange={(e) => set('fdmsBaseUrl', e.target.value)}
              placeholder="https://fdmsapi.zimra.co.zw"
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label>Workstation</label>
            <input
              value={form.fdmsWorkstation}
              onChange={(e) => set('fdmsWorkstation', e.target.value)}
              placeholder="Optional workstation label"
              autoComplete="off"
            />
          </div>
        </div>

        <div className="panel-bd mt-3">
          <div className="setup-row">
            <span className="setup-lbl">Device state</span>
            <span className="setup-val">
              {fs('registered') ? (
                <span className="badge badge-green">Registered</span>
              ) : (
                <span className="badge badge-gray">Not registered</span>
              )}{' '}
              {fs('dayNo', 0) > 0 ? (
                <span className="badge badge-blue">Day {fs('dayNo')} open</span>
              ) : (
                <span className="badge badge-gray">Day closed</span>
              )}
              {fs('pendingQueue', 0) > 0 && <span className="badge badge-amber">{fs('pendingQueue')} queued</span>}
            </span>
          </div>
          <div className="setup-row">
            <span className="setup-lbl">Fiscal day</span>
            <span className="setup-val">
              today {fs('receiptCounter', 0)} · lifetime {fs('globalNo', 0)}
            </span>
          </div>
          {fs('lastError') && (
            <div className="setup-row">
              <span className="setup-lbl">Last error</span>
              <span className="setup-val danger">{fs('lastError')}</span>
            </div>
          )}
          <div className="row mt-3" style={{ gap: 8, display: 'flex', flexWrap: 'wrap' }}>
            <button
              className="btn btn-sm"
              disabled={!!busy || !form.fdmsDeviceId || !form.fdmsSerialNo}
              onClick={() => runFiscal('register', 'Device registered.', 'register')}
            >
              {busy === 'register' ? 'Registering…' : 'Register device'}
            </button>
            <button
              className="btn btn-sm"
              disabled={!!busy || !fs('registered')}
              onClick={() => runFiscal('open-day', 'Fiscal day opened.', 'open-day')}
            >
              {busy === 'open-day' ? 'Opening…' : 'Open day'}
            </button>
            <button
              className="btn btn-sm"
              disabled={!!busy || !fs('registered')}
              onClick={() => runFiscal('submit-queue', 'Queued receipts submitted.', 'submit-queue')}
            >
              {busy === 'submit-queue' ? 'Submitting…' : 'Submit queue'}
            </button>
            <button
              className="btn btn-sm"
              disabled={!!busy || !fs('registered') || fs('dayNo', 0) === 0}
              onClick={() => runFiscal('close-day', 'Fiscal day closed.', 'close-day')}
            >
              {busy === 'close-day' ? 'Closing…' : 'Close day'}
            </button>
          </div>
          <p className="hint mt-3">
            With FDMS enabled and registered, every paid sale is signed by the device, stamped with a fiscal receipt
            number, queued locally and flushed to ZIMRA. Receipts are issued even while offline. Make sure
            <strong> Fiscal POS mode</strong> (company section above) is on so receipts print in fiscal format.
          </p>
        </div>
      </div>
    </div>
  );
}
