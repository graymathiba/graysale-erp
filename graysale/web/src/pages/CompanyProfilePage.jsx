import { useEffect, useState } from 'react';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';

const EMPTY = {
  company_name: '',
  trading_as: '',
  address: '',
  telephone: '',
  mobile: '',
  owner_username: '',
  owner_email: '',
  current_password: '',
  new_password: '',
};

// Owner self-service: business + trading details and the owner's login
// credentials. Every change is scoped to this tenant on the backend, and
// setting a new password requires the current one.
export default function CompanyProfilePage() {
  const { user } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [loading, setLoading] = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    (async () => {
      try {
        const p = await api.get('/tenant/profile');
        setForm({ ...EMPTY, ...p });
      } catch (e) {
        if (e?.silent) return;
        toast.err(e.message);
      }
    })();
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setMsg({ type: '', text: '' });
    if (form.new_password && !form.current_password) {
      setMsg({ type: 'error', text: 'Enter your current password to set a new one.' });
      return;
    }
    setLoading(true);
    try {
      const p = await api.put('/tenant/profile', form);
      setForm({ ...EMPTY, ...p });
      setMsg({ type: 'success', text: 'Profile and credentials updated successfully.' });
      toast.ok('Profile updated.');
    } catch (ex) {
      setMsg({ type: 'error', text: ex.message || 'Failed to update login details.' });
    } finally {
      setLoading(false);
    }
  };

  // The merged ERP stores the tenant operator as role 'admin'; the standalone
  // build used an explicit 'owner' role. Both are treated as the owner here.
  if (user?.role !== 'owner' && user?.role !== 'admin') {
    return (
      <div className="page">
        <div className="panel">
          <div className="empty-state">Company profile and account credentials are restricted to the tenant owner.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-hd">
        <div className="page-title">
          <h1>Company Profile &amp; Credentials</h1>
          <p>Business details and the owner login used to access GraySale.</p>
        </div>
      </div>

      {msg.text && (
        <div className={`alert${msg.type === 'error' ? ' alert-err' : ' alert-ok'}`} role="status">
          {msg.text}
        </div>
      )}

      <form onSubmit={save}>
        <div className="panel">
          <div className="panel-hd">
            <span>Business Details</span>
          </div>
          <div className="form-grid">
            <div className="field">
              <label>Company trading name</label>
              <input value={form.company_name} onChange={(e) => set('company_name', e.target.value)} required />
            </div>
            <div className="field">
              <label>Trading as (T/A)</label>
              <input value={form.trading_as} onChange={(e) => set('trading_as', e.target.value)} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Business address</label>
              <input value={form.address} onChange={(e) => set('address', e.target.value)} />
            </div>
            <div className="field">
              <label>Telephone</label>
              <input value={form.telephone} onChange={(e) => set('telephone', e.target.value)} />
            </div>
            <div className="field">
              <label>Cell / Mobile</label>
              <input value={form.mobile} onChange={(e) => set('mobile', e.target.value)} />
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-hd">
            <span>Owner Login Details</span>
          </div>
          <div className="form-grid">
            <div className="field">
              <label>Owner username</label>
              <input
                value={form.owner_username}
                onChange={(e) => set('owner_username', e.target.value)}
                required
                autoComplete="username"
              />
            </div>
            <div className="field">
              <label>Owner email</label>
              <input
                type="email"
                value={form.owner_email}
                onChange={(e) => set('owner_email', e.target.value)}
                required
              />
            </div>
          </div>

          <div className="panel-bd" style={{ borderTop: '1px solid var(--border)' }}>
            <h3 style={{ fontSize: 13, fontWeight: 800, margin: '0 0 12px' }}>
              Change password <span style={{ fontWeight: 500, color: 'var(--faint)' }}>(optional)</span>
            </h3>
            <div className="form-grid">
              <div className="field">
                <label>New password</label>
                <input
                  type="password"
                  placeholder="Leave blank to keep existing password"
                  value={form.new_password}
                  onChange={(e) => set('new_password', e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              {form.new_password && (
                <div className="field">
                  <label>Current password</label>
                  <input
                    type="password"
                    value={form.current_password}
                    onChange={(e) => set('current_password', e.target.value)}
                    autoComplete="current-password"
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="page-actions">
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? 'Saving changes…' : 'Update Login &amp; Profile'}
          </button>
        </div>
      </form>
    </div>
  );
}
