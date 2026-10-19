import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/Toast';
import { fmtDate } from '../../lib/format';

const PLANS = [
  { value: 'MONTHLY', label: '30 Days' },
  { value: 'QUARTERLY', label: '90 Days' },
  { value: 'ANNUAL', label: '365 Days' },
  { value: 'LIFETIME', label: 'Lifetime' },
];

const STATUS_TABS = [
  { value: '', label: 'All' },
  { value: 'UNUSED', label: 'Unused' },
  { value: 'REDEEMED', label: 'Redeemed' },
  { value: 'REVOKED', label: 'Revoked' },
];

// View B — Product Key Generator & Manager.
// Single/bulk generation of GS-XXXX-XXXX-XXXX activation keys, plus an
// inventory list with status filtering, one-click copy, and revoke.
export default function KeyGenerator() {
  const toast = useToast();
  const [keys, setKeys] = useState(null);
  const [status, setStatus] = useState('');
  const [planType, setPlanType] = useState('MONTHLY');
  const [count, setCount] = useState('1');
  const [generated, setGenerated] = useState([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');

  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    setKeys(await api.get(`/superadmin/keys?${q}`));
  }, [status]);

  useEffect(() => {
    (async () => {
      try {
        await load();
      } catch (e) {
        if (!e?.silent) toast.err(e.message);
      }
    })();
  }, [load]);

  const generate = async () => {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      toast.err('Count must be 1–100');
      return;
    }
    setBusy(true);
    try {
      const r = await api.post('/superadmin/keys/generate', { planType, count: n });
      setGenerated(r.keys || []);
      toast.ok(`${r.count} key(s) generated`);
      await load();
    } catch (e) {
      if (!e?.silent) toast.err(e.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (k) => {
    if (!window.confirm(`Revoke ${k.key_code}? Redeemed tenants will drop to PENDING_KEY.`)) return;
    try {
      await api.post(`/superadmin/keys/${k.id}/revoke`);
      toast.ok(`${k.key_code} revoked`);
      await load();
    } catch (e) {
      if (!e?.silent) toast.err(e.message);
    }
  };

  const copy = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied(''), 1600);
    } catch (_) {
      toast.err('Clipboard unavailable — copy manually');
    }
  };

  const badge = (s) => {
    const map = { UNUSED: 'badge-blue', REDEEMED: 'badge-green', REVOKED: 'badge-gray' };
    return `badge ${map[s] || 'badge-gray'}`;
  };

  return (
    <div className="ct-view">
      <div className="grid-1-1">
        <div className="panel">
          <div className="panel-hd">
            <span>Generate activation keys</span>
          </div>
          <div className="panel-bd">
            <div className="fields-3">
              <div className="field">
                <label>Plan duration</label>
                <select value={planType} onChange={(e) => setPlanType(e.target.value)}>
                  {PLANS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Quantity</label>
                <input type="number" min="1" max="100" value={count} onChange={(e) => setCount(e.target.value)} />
              </div>
              <div className="field" style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={busy} onClick={generate}>
                  {busy ? 'Generating…' : 'Generate keys'}
                </button>
              </div>
            </div>

            {generated.length > 0 && (
              <div className="ct-generated mt-4">
                <div className="ct-generated-hd">
                  <span>New keys — ready to distribute (SMS / WhatsApp / Email)</span>
                  <button className="btn-link" onClick={() => setGenerated([])}>
                    Dismiss
                  </button>
                </div>
                {generated.map((k, i) => (
                  <div className="ct-key-row" key={i}>
                    <code className="ct-key-code">{k.keyCode}</code>
                    <span className="muted" style={{ fontSize: 11 }}>
                      {PLANS.find((p) => p.value === k.planType)?.label}
                    </span>
                    <button className="btn btn-sm" onClick={() => copy(k.keyCode)}>
                      {copied === k.keyCode ? 'Copied ✓' : 'Copy Key'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-hd">
            <span>Key inventory</span>
          </div>
          <div className="panel-bd">
            <div className="seg" style={{ marginBottom: 12 }}>
              {STATUS_TABS.map((s) => (
                <button key={s.value} className={status === s.value ? 'seg-on' : ''} onClick={() => setStatus(s.value)}>
                  {s.label}
                </button>
              ))}
            </div>
            <div className="ct-inventory">
              {!keys ? (
                <div className="loader">
                  <span className="spinner" />
                  Loading…
                </div>
              ) : keys.length === 0 ? (
                <div className="empty-state">No keys match this filter.</div>
              ) : (
                keys.map((k) => (
                  <div className="ct-key-row" key={k.id}>
                    <div className="ct-key-main">
                      <code className="ct-key-code">{k.key_code}</code>
                      <span className={badge(k.status)}>{k.status}</span>
                    </div>
                    <div className="ct-key-meta">
                      <span>{k.tenant_name || '—'}</span>
                      <span className="muted">{k.plan_type}</span>
                      {k.used_at && <span className="muted">{fmtDate(k.used_at)}</span>}
                    </div>
                    <div className="row-actions">
                      <button className="btn btn-sm" onClick={() => copy(k.key_code)}>
                        {copied === k.key_code ? 'Copied ✓' : 'Copy'}
                      </button>
                      {k.status === 'UNUSED' && (
                        <button className="btn-link danger" onClick={() => revoke(k)}>
                          Revoke
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
