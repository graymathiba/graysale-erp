import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
      const { user: u, tenant } = await login(username, password);
      if (tenant?.needsActivation) {
        toast.ok(`Welcome, ${u.fullName || u.username}`);
        navigate('/activate-license');
        return;
      }
      toast.ok(`Welcome, ${u.fullName || u.username}`);
      navigate(u.role === 'cashier' ? '/pos' : '/dashboard');
    } catch (ex) {
      setErr(ex.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark" style={{ display: 'flex' }}>GS</div>
        <h1>GraySale ERP</h1>
        <p className="sub">Retail Point of Sale &amp; Accounting</p>
        <div className="field">
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
        <div className="login-err">{err}</div>
        <button className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Signing in…' : 'Log In'}
        </button>
      </form>
    </div>
  );
}
