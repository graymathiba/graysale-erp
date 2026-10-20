import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';

export default function LoginPage() {
  const { login } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const { user: u, tenant, requiresPasswordChange } = await login(username, password);
      if (requiresPasswordChange) {
        navigate('/set-password', { replace: true });
        return;
      }
      if (tenant?.needsActivation) {
        toast.ok(`Welcome, ${u.fullName || u.username}`);
        navigate('/activate-license');
        return;
      }
      toast.ok(`Welcome, ${u.fullName || u.username}`);
      navigate(u.role === 'cashier' ? '/desktop/pos' : '/desktop');
    } catch (ex) {
      setErr(ex.message || 'Login failed');
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
        <h1>GraySale ERP</h1>
        <p className="sub">Retail Point of Sale &amp; Accounting</p>
        <div className="field">
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
        </div>
        <div className="field">
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <div className="login-err">{err}</div>
        <button className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Signing in…' : 'Log In'}
        </button>
        <p style={{ marginTop: 16, fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>
          <Link to="/register" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
            Create an Account
          </Link>
        </p>
      </form>
    </div>
  );
}
