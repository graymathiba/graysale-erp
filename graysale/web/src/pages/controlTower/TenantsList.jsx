import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/Toast';
import Modal from '../../components/Modal';
import DataTable, { Badge } from '../../components/DataTable';
import { fmtDate } from '../../lib/format';

function shortPath(p) {
  if (!p) return '—';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `…\\${parts.slice(-3).join('\\')}` : p;
}

// View A — Company Tenants Overseer.
// Lists every onboarded GraySale company with live block/unblock, subscription
// extension, and quick onboarding. All calls are super-admin gated server-side.
export default function TenantsList() {
  const toast = useToast();
  const [tenants, setTenants] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [extendTenant, setExtendTenant] = useState(null);
  const [extendDays, setExtendDays] = useState('30');
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({
    companyName: '',
    ownerEmail: '',
    ownerUsername: '',
    ownerPassword: '',
    storageKind: '',
    storagePath: '',
  });
  const [editTenant, setEditTenant] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (search) q.set('search', search);
    if (statusFilter) q.set('status', statusFilter);
    setTenants(await api.get(`/superadmin/tenants?${q}`));
  }, [search, statusFilter]);

  useEffect(() => {
    (async () => {
      try {
        await load();
      } catch (e) {
        if (!e?.silent) toast.err(e.message);
      }
    })();
  }, [load]);

  const toggle = async (t) => {
    setBusyId(t.id);
    try {
      const next = await api.post(`/superadmin/tenants/${t.id}/toggle`);
      toast.ok(next.status === 'BLOCKED' ? `${next.company_name} blocked` : `${next.company_name} unblocked`);
      await load();
    } catch (e) {
      if (!e?.silent) toast.err(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const doExtend = async () => {
    const days = Number(extendDays);
    if (!Number.isInteger(days) || days <= 0) {
      toast.err('Enter a positive number of days');
      return;
    }
    try {
      const next = await api.post(`/superadmin/tenants/${extendTenant.id}/extend`, { days });
      toast.ok(`Extended ${next.company_name} by ${days} day(s) → ${fmtDate(next.license_expires_at)}`);
      setExtendTenant(null);
      await load();
    } catch (e) {
      if (!e?.silent) toast.err(e.message);
    }
  };

  const addTenant = async () => {
    if (!addForm.companyName.trim() || !addForm.ownerEmail.trim()) {
      toast.err('Company name and owner email are required');
      return;
    }
    const hasCustomStorage = addForm.storageKind.trim() || addForm.storagePath.trim();
    const body = { companyName: addForm.companyName, ownerEmail: addForm.ownerEmail };
    if (addForm.ownerUsername.trim()) body.ownerUsername = addForm.ownerUsername.trim();
    if (addForm.ownerPassword) body.password = addForm.ownerPassword;
    if (hasCustomStorage) {
      body.storage = {
        kind: addForm.storageKind || 'local',
        path: addForm.storagePath.trim() || null,
        environmentReady: true,
      };
    }
    try {
      const t = await api.post('/superadmin/tenants', body);
      toast.ok(`${t.company_name} onboarded in ${t.status} state`);
      if (t.tempPassword) {
        toast.ok(
          `Owner temporary password: ${t.tempPassword} — share it with the owner; they must change it on first login.`,
        );
      }
      setShowAdd(false);
      setAddForm({
        companyName: '',
        ownerEmail: '',
        ownerUsername: '',
        ownerPassword: '',
        storageKind: '',
        storagePath: '',
      });
      await load();
    } catch (e) {
      if (!e?.silent) toast.err(e.message);
    }
  };

  const openEdit = (t) => {
    setEditTenant(t);
    setEditForm({
      company_name: t.company_name || '',
      owner_email: t.owner_email || '',
      owner_username: t.owner_username || '',
      address: '',
      telephone: '',
      new_password: '',
    });
  };

  const saveEdit = async () => {
    if (!editForm.company_name.trim() || !editForm.owner_email.trim()) {
      toast.err('Company name and owner email are required');
      return;
    }
    try {
      const next = await api.put(`/superadmin/tenants/${editTenant.id}`, editForm);
      toast.ok(`${next.company_name} updated`);
      setEditTenant(null);
      await load();
    } catch (e) {
      if (!e?.silent) toast.err(e.message);
    }
  };

  const columns = [
    {
      key: 'company',
      label: 'Company',
      render: (r) => (
        <div className="cd">
          <div className="p-thumb">
            {String(r.company_name || '?')
              .slice(0, 2)
              .toUpperCase()}
          </div>
          <div className="cd-txt">
            <div className="cd-nm">{r.company_name}</div>
            <div className="cd-sub">Owner · {r.owner_email || '—'}</div>
          </div>
        </div>
      ),
    },
    { key: 'activeUsers', label: 'Active Users', num: true },
    { key: 'status', label: 'Plan Status', render: (r) => <Badge status={r.status} /> },
    {
      key: 'license_expires_at',
      label: 'Expiry Date',
      render: (r) => <span className={r.isExpired ? 'danger' : ''}>{fmtDate(r.license_expires_at)}</span>,
    },
    {
      key: 'storage',
      label: 'Data Storage',
      render: (r) => {
        const s = r.storage || {};
        if (!s.kind && !s.path) return <span className="muted">—</span>;
        return (
          <div className="cd-txt">
            <div className="cd-nm">{String(s.kind || 'local').toUpperCase()}</div>
            <div className="cd-sub mono" title={s.path}>
              {shortPath(s.path)}
            </div>
            {s.environmentReady === false && <Badge status="PENDING_ACTIVATION">env not ready</Badge>}
          </div>
        );
      },
    },
    {
      key: 'access',
      label: 'Access',
      render: (r) => (
        <div className="ct-toggle-wrap">
          <button
            className={`ct-switch${r.status === 'BLOCKED' ? ' off' : ' on'}`}
            role="switch"
            aria-checked={r.status !== 'BLOCKED'}
            title={r.status === 'BLOCKED' ? 'Unblock access' : 'Block access'}
            disabled={busyId === r.id}
            onClick={() => toggle(r)}
          >
            <span className="ct-switch-thumb" />
          </button>
          <span className={`ct-toggle-lbl${r.status === 'BLOCKED' ? ' danger' : ' ok'}`}>
            {r.status === 'BLOCKED' ? 'Blocked' : 'Active'}
          </span>
        </div>
      ),
    },
    {
      key: 'actions',
      label: '',
      render: (r) => (
        <div className="row-actions">
          <button className="btn-link" onClick={() => openEdit(r)}>
            Edit
          </button>
          <button
            className="btn-link"
            onClick={() => {
              setExtendTenant(r);
              setExtendDays('30');
            }}
          >
            Extend
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="ct-view">
      <div className="toolbar">
        <input
          className="search-input"
          placeholder="Search company or owner email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="cat-select-input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="PENDING_ACTIVATION">Pending Activation</option>
          <option value="BLOCKED">Blocked</option>
          <option value="EXPIRED">Expired</option>
          <option value="PENDING_KEY">Pending Key</option>
        </select>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
          + Onboard company
        </button>
      </div>

      <DataTable columns={columns} rows={tenants} empty="No companies found." />

      {extendTenant && (
        <Modal
          title={`Extend subscription — ${extendTenant.company_name}`}
          onClose={() => setExtendTenant(null)}
          footer={
            <>
              <button className="btn" onClick={() => setExtendTenant(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={doExtend}>
                Extend subscription
              </button>
            </>
          }
        >
          <div className="field">
            <label>Days to extend</label>
            <input type="number" min="1" value={extendDays} onChange={(e) => setExtendDays(e.target.value)} />
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            Current expiry: <strong>{fmtDate(extendTenant.license_expires_at)}</strong>. Extension counts from the later
            of today and the current expiry.
          </p>
        </Modal>
      )}

      {showAdd && (
        <Modal
          title="Onboard a company tenant"
          onClose={() => setShowAdd(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowAdd(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={addTenant}>
                Onboard
              </button>
            </>
          }
        >
          <div className="field">
            <label>Company name</label>
            <input
              value={addForm.companyName}
              onChange={(e) => setAddForm({ ...addForm, companyName: e.target.value })}
              autoFocus
            />
          </div>
          <div className="field">
            <label>Owner email</label>
            <input
              value={addForm.ownerEmail}
              onChange={(e) => setAddForm({ ...addForm, ownerEmail: e.target.value })}
              placeholder="owner@company.com"
            />
          </div>
          <div className="field">
            <label>
              Owner username <span className="muted">(default: the email local-part)</span>
            </label>
            <input
              value={addForm.ownerUsername}
              onChange={(e) => setAddForm({ ...addForm, ownerUsername: e.target.value })}
              placeholder="owner"
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label>
              Owner password <span className="muted">(optional)</span>
            </label>
            <input
              type="password"
              value={addForm.ownerPassword}
              onChange={(e) => setAddForm({ ...addForm, ownerPassword: e.target.value })}
              placeholder="Leave blank for a one-time temporary password"
              autoComplete="new-password"
            />
          </div>
          <div className="field">
            <label>Storage kind</label>
            <select
              className="cat-select-input"
              value={addForm.storageKind}
              onChange={(e) => setAddForm({ ...addForm, storageKind: e.target.value })}
            >
              <option value="">local (this machine)</option>
              <option value="portable">portable (USB / moved folder)</option>
              <option value="network">network share</option>
            </select>
          </div>
          <div className="field">
            <label>
              Storage path <span className="muted">(optional — leave blank to use this instance's data folder)</span>
            </label>
            <input
              className="mono"
              value={addForm.storagePath}
              onChange={(e) => setAddForm({ ...addForm, storagePath: e.target.value })}
              placeholder="D:\GraySaleData"
            />
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            The tenant starts in <strong>PENDING_KEY</strong> state until a product key is redeemed against it. When no
            password is set, the owner gets a temporary password and must create their own on first login. Storage
            metadata records where its books live.
          </p>
        </Modal>
      )}

      {editTenant && (
        <Modal
          title={`Edit tenant — ${editTenant.company_name}`}
          onClose={() => setEditTenant(null)}
          footer={
            <>
              <button className="btn" onClick={() => setEditTenant(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={saveEdit}>
                Save changes
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="field">
              <label>Company name</label>
              <input
                value={editForm.company_name}
                onChange={(e) => setEditForm({ ...editForm, company_name: e.target.value })}
                autoFocus
              />
            </div>
            <div className="field">
              <label>Owner email</label>
              <input
                type="email"
                value={editForm.owner_email}
                onChange={(e) => setEditForm({ ...editForm, owner_email: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Owner username</label>
              <input
                value={editForm.owner_username}
                onChange={(e) => setEditForm({ ...editForm, owner_username: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Address</label>
              <input
                value={editForm.address}
                onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
                placeholder="Leave blank to keep current"
              />
            </div>
            <div className="field">
              <label>Telephone</label>
              <input
                value={editForm.telephone}
                onChange={(e) => setEditForm({ ...editForm, telephone: e.target.value })}
                placeholder="Leave blank to keep current"
              />
            </div>
          </div>
          <div className="form-grid" style={{ paddingTop: 4 }}>
            <div className="field">
              <label>Reset owner password</label>
              <input
                type="password"
                value={editForm.new_password}
                onChange={(e) => setEditForm({ ...editForm, new_password: e.target.value })}
                placeholder="Leave blank to keep existing"
                autoComplete="new-password"
              />
            </div>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            Password resets force the owner to log in again; existing sessions are invalidated.
          </p>
        </Modal>
      )}
    </div>
  );
}
