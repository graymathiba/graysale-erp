import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useToast } from '../components/Toast';

// First-run setup screen — a single-purpose folder picker.
// No technical metadata, no diagnostic readouts. Just: pick the folder, continue.
export default function StorageSetupPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const d = await api.get('/setup/status', { skipAuthGuard: true });
      setData(d);
      const phase = d?.storage?.phase;
      const root = d?.storage?.storage?.root || '';
      if (phase === 'ready') {
        setTimeout(() => navigate('/login', { replace: true }), 0);
        return;
      }
      setSelectedFolder(root);
    } catch (e) {
      setErr(e.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (!data) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="loader">
            <span className="spinner" />
          </div>
        </div>
      </div>
    );
  }

  const st = data.storage;
  const phase = st?.phase;
  const isNewEnv = phase === 'new_environment';

  if (phase === 'ready') {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="loader">
            <span className="spinner" />
          </div>
        </div>
      </div>
    );
  }

  const handleConfirm = async () => {
    const folder = selectedFolder.trim();
    if (!folder) {
      setErr('Enter a folder path.');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const r = await api.post('/setup/storage', { root: folder, kind: 'local' }, { skipAuthGuard: true });
      if (!r.ok) throw new Error(r.error || r.message || 'Setup failed');
      if (r.reload) await new Promise((res) => setTimeout(res, 700));
      const again = await api.get('/setup/status', { skipAuthGuard: true });
      if (again?.storage?.phase === 'ready') navigate('/login', { replace: true });
      else toast.ok('Storage configured.');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleAdopt = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.post('/setup/storage/adopt', {}, { skipAuthGuard: true });
      if (!r.ok) throw new Error(r.error || r.message || 'Setup failed');
      navigate('/login', { replace: true });
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card setup-dialog">
        {/* Brand icon */}
        <div className="setup-brand">
          <span className="brand-mark">GS</span>
        </div>

        {/* Header */}
        <h2 className="setup-title">GraySale data home</h2>
        <p className="setup-sub">
          {isNewEnv
            ? 'This data was created on another computer. Acknowledge before continuing, or pick a new folder.'
            : 'Choose where your local database and business files will live on this PC.'}
        </p>

        {/* Folder path input */}
        <div className="setup-field">
          <label className="setup-field-label">Data Storage Location</label>
          <input
            className="setup-field-input"
            type="text"
            value={selectedFolder}
            onChange={(e) => setSelectedFolder(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {/* Primary action */}
        {isNewEnv ? (
          <button className="setup-btn-primary" disabled={busy} onClick={handleAdopt}>
            {busy ? 'Working…' : 'Use this data'}
          </button>
        ) : (
          <button className="setup-btn-primary" disabled={busy} onClick={handleConfirm}>
            {busy ? 'Saving…' : 'Continue with this folder'}
          </button>
        )}

        {err && (
          <div className="alert alert-err" style={{ marginTop: 12 }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
