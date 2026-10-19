import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';

const STATUS_LABEL = {
  PENDING_KEY: 'No license key on file',
  PENDING_ACTIVATION: 'License pending activation',
  BLOCKED: 'License blocked',
  ACTIVE: 'License active',
  EXPIRED: 'License expired',
  REVOKED: 'License revoked',
};

// Public-facing activation gate. Reachable without an active license, because
// /license/* routes bypass the backend tenant gate entirely.
export default function ActivateLicensePage() {
  const { user, refreshTenant } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [status, setStatus] = useState(null);
  const [keyCode, setKeyCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s = await api.get('/license/status', { skipAuthGuard: true });
        setStatus(s);
      } catch (e) {
        setErr(e.message || 'Could not read license status.');
      }
    })();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!keyCode.trim()) {
      setErr('Enter the license key supplied by your provider.');
      return;
    }
    setErr('');
    setBusy(true);
    try {
      await api.post('/license/activate', { key_code: keyCode.trim() });
      toast.ok('License activated!');
      await refreshTenant();
      navigate('/dashboard');
    } catch (ex) {
      setErr(ex.message || 'Activation failed. Check the key and try again.');
    } finally {
      setBusy(false);
    }
  };

  const ready = status && !status.activationRequired;

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark" style={{ display: 'flex' }}>
          GS
        </div>
        <h1>Activate GraySale</h1>
        <p className="sub">{status?.companyName || user?.tenant?.company_name || 'Your business'}</p>

        {status && (
          <div className={`field activation-status activation-${status.status.toLowerCase()}`}>
            <label>License status</label>
            <div className="activation-status-line">
              <span className={`badge badge-${status.status.toLowerCase()}`}>
                {STATUS_LABEL[status.status] || status.status}
              </span>
              {status.licenseKey && <span className="activation-key">{status.licenseKey}</span>}
            </div>
          </div>
        )}

        {!ready && (
          <>
            <p className="sub" style={{ marginTop: 4 }}>
              Enter the product key issued for this instance to unlock the store.
            </p>
            <div className="field">
              <label>License key</label>
              <input
                value={keyCode}
                onChange={(e) => setKeyCode(e.target.value)}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                autoComplete="off"
                autoFocus
                spellCheck={false}
              />
            </div>
            <div className="login-err">{err}</div>
            <button className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={busy}>
              {busy ? 'Activating…' : 'Activate'}
            </button>
          </>
        )}

        {ready && (
          <>
            <div className="login-err" />
            <button
              type="button"
              className="btn btn-primary btn-lg"
              style={{ width: '100%' }}
              onClick={() => navigate('/dashboard')}
            >
              Enter the store
            </button>
          </>
        )}
      </form>
    </div>
  );
}
