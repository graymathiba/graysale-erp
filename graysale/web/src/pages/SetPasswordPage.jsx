import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../api/AuthContext';
import { api } from '../api/client';
import { useToast } from '../components/Toast';

// Forced password change screen — the backend returned requiresPasswordChange
// on login. The user must set a new password before any screen is reachable.
export default function SetPasswordPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user, tenant, logout } = useAuth();
  const [newPass, setNewPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (newPass.length < 6) {
      setErr('Password must be at least 6 characters.');
      return;
    }
    if (newPass !== confirm) {
      setErr('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const r = await api.post('/auth/set-password', { password: newPass });
      if (!r.ok) throw new Error(r.error || 'Failed to set password');
      toast.ok('Password updated.');
      // An onboarded-but-not-yet-activated tenant still has their product key
      // to redeem, so continue to the activation screen rather than the app.
      if (tenant?.needsActivation) {
        navigate('/activate-license', { replace: true });
        return;
      }
      navigate(user?.role === 'cashier' ? '/pos' : '/desktop', { replace: true });
    } catch (ex) {
      setErr(ex.message || 'Failed to set password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark" style={{ display: 'flex' }}>
          GS
        </div>
        <h1>Set your password</h1>
        <p className="sub">Your account requires a password change before continuing.</p>

        <div className="field">
          <label>New password</label>
          <input
            type="password"
            value={newPass}
            onChange={(e) => setNewPass(e.target.value)}
            autoFocus
            autoComplete="new-password"
          />
        </div>
        <div className="field">
          <label>Confirm password</label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        </div>

        <div className="login-err">{err}</div>
        <button className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Saving…' : 'Continue'}
        </button>
        <p style={{ marginTop: 16, fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>
          <button
            type="button"
            className="btn"
            style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12.5 }}
            onClick={() => {
              logout();
              navigate('/login', { replace: true });
            }}
          >
            Log out instead
          </button>
        </p>
      </form>
    </div>
  );
}
