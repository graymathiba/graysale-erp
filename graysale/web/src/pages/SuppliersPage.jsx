import { useEffect, useState } from 'react';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import Modal from '../components/Modal';
import DataTable from '../components/DataTable';
import { fmtMoney } from '../lib/format';

export default function SuppliersPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(null);
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '', taxId: '' });

  const load = async (q) => {
    try {
      const list = await api.get(`/suppliers${q ? '?search=' + encodeURIComponent(q) : ''}`);
      setRows(Array.isArray(list) ? list : list.suppliers || []);
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    }
  };
  useEffect(() => {
    load('');
  }, []);
  useEffect(() => {
    const t = setTimeout(() => load(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  const save = async () => {
    if (!form.name) {
      toast.warn('Name required');
      return;
    }
    try {
      if (creating?.id) await api.put(`/suppliers/${creating.id}`, form);
      else await api.post('/suppliers', form);
      toast.ok('Saved');
      setCreating(null);
      load('');
      setSearch('');
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    }
  };

  const cols = [
    {
      key: 'name',
      label: 'Supplier',
      render: (r) => (
        <div className="cd">
          <div className="cd-txt">
            <div className="cd-nm">{r.name}</div>
            <div className="cd-sub">{r.code || ''}</div>
          </div>
        </div>
      ),
    },
    { key: 'phone', label: 'Phone', render: (r) => r.phone || '—' },
    { key: 'email', label: 'Email', render: (r) => r.email || '—' },
    { key: 'tax', label: 'Tax ID', render: (r) => r.tax_id || '—' },
    { key: 'bal', label: 'Balance', num: true, render: (r) => fmtMoney(r.balance_cents ?? 0) },
    {
      key: 'actions',
      label: 'Actions',
      render: (r) => (
        <div className="row-actions">
          {can('suppliers.manage') && (
            <button
              className="btn-link"
              onClick={() => {
                setCreating({ id: r.id });
                setForm({
                  name: r.name,
                  phone: r.phone || '',
                  email: r.email || '',
                  address: r.address || '',
                  taxId: r.tax_id || '',
                });
              }}
            >
              Edit
            </button>
          )}
          {can('suppliers.manage') && (
            <button
              className="btn-link danger"
              onClick={async () => {
                if (!window.confirm(`Deactivate ${r.name}?`)) return;
                try {
                  await api.del(`/suppliers/${r.id}`);
                  toast.ok('Supplier removed');
                  load('');
                } catch (e) {
                  if (e?.silent) return;
                  toast.err(e.message);
                }
              }}
            >
              Remove
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="page">
      <div className="page-hd">
        <div className="page-title">
          <h1>Suppliers</h1>
          <p>Vendor accounts and balances.</p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => {
            setCreating({});
            setForm({ name: '', phone: '', email: '', address: '', taxId: '' });
          }}
          disabled={!can('suppliers.manage')}
        >
          + New supplier
        </button>
      </div>
      <div className="toolbar">
        <input placeholder="Search suppliers…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        empty="No suppliers."
        caption={
          <div className="table-capt">
            <span>All suppliers</span>
            <span className="muted">{rows.length}</span>
          </div>
        }
      />

      {creating && (
        <Modal
          title={creating.id ? 'Edit supplier' : 'New supplier'}
          onClose={() => setCreating(null)}
          footer={
            <button className="btn btn-primary" onClick={save}>
              {creating.id ? 'Save' : 'Create'}
            </button>
          }
        >
          <div className="field">
            <label>Name *</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label>Phone</label>
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div className="field">
            <label>Email</label>
            <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="field">
            <label>Address</label>
            <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </div>
          <div className="field">
            <label>Tax ID</label>
            <input value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} />
          </div>
        </Modal>
      )}
    </div>
  );
}
