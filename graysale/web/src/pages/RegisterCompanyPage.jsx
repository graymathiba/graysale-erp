import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api, authStore } from '../api/client';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';

// Self-service tenant registration: create a company + owner account in one
// step. A signed-in session is created immediately; PENDING_ACTIVATION tenants
// are routed to /activate-license to redeem their product key.
export default function RegisterCompanyPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { setUser, setTenant } = useAuth();
  const [companyName, setCompanyName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (password.length < 6) {
      setErr('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setErr('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const r = await api.post(
        '/auth/register-tenant',
        {
          companyName,
          username,
          email,
          password,
        },
        { skipAuthGuard: true },
      );
      if (!r.ok) throw new Error(r.error || 'Registration failed');
      // Persist the session the backend returned and adopt it into the auth
      // context so the app treats the owner as signed in immediately.
      authStore.set({ token: r.token, user: r.user, tenant: r.tenant });
      setUser(r.user);
      setTenant(r.tenant);
      toast.ok('Account created — welcome to GraySale!');
      const pending = ['PENDING_KEY', 'PENDING_ACTIVATION', 'BLOCKED'].includes(r.tenant?.status);
      navigate(pending ? '/activate-license' : '/dashboard', { replace: true });
    } catch (ex) {
      setErr(ex.message || 'Registration failed');
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
        <h1>Create your company</h1>
        <p className="sub">Set up a new GraySale workspace for your business.</p>

        <div className="field">
          <label>Company name</label>
          <input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="e.g. Westside Electronics"
            autoFocus
          />
        </div>
        <div className="field">
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </div>
        <div className="field">
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </div>
        <div className="field">
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
          {busy ? 'Creating…' : 'Create Account'}
        </button>
        <p style={{ marginTop: 16, fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>
          Already have an account?{' '}
          <Link to="/login" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
            Log In
          </Link>
        </p>
      </form>
    </div>
  );
}
