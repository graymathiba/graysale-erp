import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import Modal from '../components/Modal';
import { fmtDT } from '../lib/format';

const ROLES = ['owner', 'manager', 'accountant', 'cashier'];
const ROLE_LABEL = { owner: 'Owner', manager: 'Manager', accountant: 'Accountant', cashier: 'Cashier' };

/**
 * UserManagementTable — compact, terminal-friendly admin panel for login
 * accounts. Inline role assignment, edit detail, deactivate / reactivate, and
 * permanent delete (blocked when the target user holds an open shift — the
 * backend enforces this too).
 */
export default function UserManagementTable() {
  const { user: me, can } = useAuth();
  const toast = useToast();

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // user being edited
  const [creating, setCreating] = useState(false);
  const [touch, setTouch] = useState(null);     // { type:'deactivate'|'reactivate'|'delete', user }
  const [form, setForm] = useState({ username: '', fullName: '', password: '', role: 'cashier' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.get('/users');
      setUsers(Array.isArray(list) ? list : list.users || []);
    } catch (e) {
      // 401/403 are surfaced centrally (silent) — never fail the table with noise.
      if (e?.silent) return;
      toast.err(e.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const isMe = (u) => me?.id === u.id;

  const canTouch = (u) => can('users.delete') && !isMe(u) && u.role !== 'owner';

  const setRole = async (u, role) => {
    if (role === u.role) return;
    try {
      await api.put(`/users/${u.id}`, { role });
      toast.ok(`${u.username} → ${ROLE_LABEL[role]}`);
      load();
    } catch (e) { toast.err(e.message); }
  };

  const openCreate = () => { setCreating(true); setForm({ username: '', fullName: '', password: '', role: 'cashier' }); };
  const openEdit = (u) => { setEditing(u); setForm({ username: u.username, fullName: u.full_name || u.fullName || '', role: u.role, password: '' }); };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (creating) {
        if (!form.username || !form.password) { toast.warn('Username and password are required'); return; }
        await api.post('/users', form);
        toast.ok('User created');
      } else {
        const body = { username: form.username, fullName: form.fullName, role: form.role };
        body.active = true;
        if (form.password) body.password = form.password;
        await api.put(`/users/${editing.id}`, body);
        toast.ok('User updated');
      }
      setCreating(false); setEditing(null);
      load();
    } catch (e) { toast.err(e.message); }
    finally { setBusy(false); }
  };

  const confirmTouch = async () => {
    if (!touch || busy) return;
    const u = touch.user;
    setBusy(true);
    try {
      if (touch.type === 'delete') {
        await api.del(`/users/${u.id}?permanent=1`);
        toast.ok(`${u.username} permanently deleted`);
      } else if (touch.type === 'reactivate') {
        await api.put(`/users/${u.id}`, { active: true });
        toast.ok(`${u.username} reactivated`);
      } else {
        await api.del(`/users/${u.id}`);
        toast.ok(`${u.username} deactivated`);
      }
      setTouch(null);
      load();
    } catch (e) { toast.err(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="umt">
      <div className="umt-toolbar">
        <span className="umt-count">{loading ? 'Loading…' : `${users.length} login account${users.length === 1 ? '' : 's'}`}</span>
        <button className="btn btn-primary btn-sm" onClick={openCreate} disabled={!can('users.manage')}>+ New user</button>
      </div>

      <div className="umt-table-wrap">
        <table className="grid umt-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Status</th>
              <th>Created</th>
              <th className="umt-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5}><div className="loader"><span className="spinner" />Loading users…</div></td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={5}><div className="empty-state">No users found.</div></td></tr>
            ) : users.map((u) => (
              <tr key={u.id}>
                <td>
                  <div className="umt-name">{u.full_name || u.username}{isMe(u) ? ' (you)' : ''}</div>
                  <div className="cd-sub">{u.username}</div>
                </td>
                <td>
                  <select className="umt-role" value={u.role}
                    onChange={(e) => setRole(u, e.target.value)}
                    disabled={!can('users.manage') || isMe(u) || u.role === 'owner'}>
                    {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                </td>
                <td>
                  <span className={`badge ${u.active ? 'badge-green' : 'badge-gray'}`}>{u.active ? 'ACTIVE' : 'INACTIVE'}</span>
                </td>
                <td className="num mono muted">{fmtDT(u.created_at)}</td>
                <td className="umt-actions">
                  <div className="row-actions">
                    <button className="btn-link" onClick={() => openEdit(u)} disabled={!can('users.manage')}>Edit</button>
                    {canTouch(u) && (
                      <>
                        {u.active
                          ? <button className="btn-link warn" onClick={() => setTouch({ type: 'deactivate', user: u })}>Deactivate</button>
                          : <button className="btn-link" onClick={() => setTouch({ type: 'reactivate', user: u })}>Reactivate</button>}
                        <button className="btn-link danger" onClick={() => setTouch({ type: 'delete', user: u })}>Delete</button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* create / edit */}
      {(creating || editing) && (
        <Modal title={creating ? 'New user' : `Edit ${form.username || editing.username}`}
          onClose={() => { setCreating(false); setEditing(null); }}
          footer={<button className="btn btn-primary" onClick={submit} disabled={busy}>{creating ? 'Create user' : 'Save changes'}</button>}>
          <div className="field"><label>Username *</label><input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} disabled={!creating} /></div>
          <div className="field"><label>Full name</label><input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></div>
          <div className="field"><label>{creating ? 'Password *' : 'New password (leave blank to keep)'}</label>
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" /></div>
          <div className="field"><label>Role</label>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </div>
          <p className="hint">Owner: full access. Manager: operations + users. Accountant: finance / reports. Cashier: POS only.</p>
        </Modal>
      )}

      {/* deactivate / reactivate / delete confirm */}
      {touch && (
        <Modal title={touch.type === 'delete' ? 'Delete user' : touch.type === 'reactivate' ? 'Reactivate user' : 'Deactivate user'}
          onClose={() => setTouch(null)}
          footer={
            <div className="modal-actions">
              <button className="btn" onClick={() => setTouch(null)}>Cancel</button>
              <button className={touch.type === 'delete' ? 'btn btn-danger' : 'btn btn-primary'} onClick={confirmTouch} disabled={busy}>
                {touch.type === 'delete' ? 'Delete permanently' : touch.type === 'reactivate' ? 'Reactivate' : 'Deactivate'}
              </button>
            </div>
          }>
          {touch.type === 'delete' ? (
            <p><b>{touch.user.username}</b> will be <b>permanently deleted</b>. History is retained but ownership is removed.
              This is blocked while this user has an open shift and cannot be undone.</p>
          ) : touch.type === 'reactivate' ? (
            <p><b>{touch.user.username}</b> will be <b>reactivated</b> and can log in again.</p>
          ) : (
            <p><b>{touch.user.username}</b> will be <b>deactivated</b>. They can no longer log in; history is preserved.
              Deactivation is blocked while this user has an open shift.</p>
          )}
        </Modal>
      )}
    </div>
  );
}