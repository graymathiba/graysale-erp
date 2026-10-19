import { useEffect, useState } from 'react';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import Modal from '../components/Modal';
import DataTable from '../components/DataTable';
import { fmtMoney, fmtDT, initials } from '../lib/format';

export default function CustomersPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState(null); // { customer, groups }
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '', taxId: '', creditLimitCents: '' });

  const load = async (q) => {
    try {
      const list = await api.get(`/customers${q ? '?search=' + encodeURIComponent(q) : ''}`);
      setRows(Array.isArray(list) ? list : list.customers || []);
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
    const body = {
      name: form.name,
      phone: form.phone,
      email: form.email,
      address: form.address,
      taxId: form.taxId || undefined,
      creditLimitCents: form.creditLimitCents === '' ? undefined : Math.round(Number(form.creditLimitCents) * 100),
    };
    try {
      if (creating) await api.post('/customers', body);
      else await api.put(`/customers/${creating.id}`, body);
      toast.ok(creating ? 'Customer created' : 'Customer updated');
      setCreating(null);
      load('');
      setSearch('');
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    }
  };

  const showDetail = async (c) => {
    try {
      const [ledger, lay] = await Promise.all([
        api.get(`/customers/${c.id}/ledger`),
        api.get(`/customers/${c.id}/layaways`),
      ]);
      setDetail({
        customer: c,
        ledger: Array.isArray(ledger) ? ledger : ledger.entries || [],
        layaways: Array.isArray(lay) ? lay : lay.rows || [],
      });
    } catch (e) {
      if (e?.silent) return;
      toast.err(e.message);
    }
  };

  const columns = [
    {
      key: 'name',
      label: 'Customer',
      render: (r) => (
        <div className="cd">
          <span className="avatar">{initials(r.name)}</span>
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
    { key: 'amt', label: 'Balance', num: true, render: (r) => fmtMoney(r.balance_cents ?? 0) },
    { key: 'pts', label: 'Points', num: true, render: (r) => r.loyalty_points ?? 0 },
    {
      key: 'actions',
      label: 'Actions',
      render: (r) => (
        <div className="row-actions">
          <button className="btn-link" onClick={() => showDetail(r)}>
            Ledger &amp; Laybys
          </button>
          {can('customers.manage') && (
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
                  creditLimitCents: r.credit_limit_cents != null ? (r.credit_limit_cents / 100).toFixed(2) : '',
                });
              }}
            >
              Edit
            </button>
          )}
          {can('customers.manage') && (
            <button
              className="btn-link danger"
              onClick={async () => {
                if (!window.confirm(`Deactivate ${r.name}?`)) return;
                try {
                  await api.del(`/customers/${r.id}`);
                  toast.ok('Customer removed');
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
          <h1>Customers</h1>
          <p>Accounts, ledger balances and laybys.</p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => {
            setCreating({});
            setForm({ name: '', phone: '', email: '', address: '', taxId: '', creditLimitCents: '' });
          }}
          disabled={!can('customers.manage')}
        >
          + New customer
        </button>
      </div>
      <div className="toolbar">
        <input placeholder="Search customers…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        empty="No customers."
        caption={
          <div className="table-capt">
            <span>All customers</span>
            <span className="muted">{rows.length}</span>
          </div>
        }
      />

      {creating && (
        <Modal
          title={creating.id ? 'Edit customer' : 'New customer'}
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
            <label>Tax ID (TIN)</label>
            <input value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} />
          </div>
          <div className="field">
            <label>Credit limit</label>
            <input
              value={form.creditLimitCents}
              onChange={(e) => setForm({ ...form, creditLimitCents: e.target.value })}
              placeholder="0.00"
            />
          </div>
        </Modal>
      )}

      {detail && (
        <Modal
          title={`${detail.customer.name} — Ledger`}
          onClose={() => setDetail(null)}
          wide
          footer={
            <button className="btn btn-primary" onClick={() => setDetail(null)}>
              Close
            </button>
          }
        >
          <h3>Ledger</h3>
          <table className="grid">
            <thead>
              <tr>
                <th>Date</th>
                <th>Ref</th>
                <th>Type</th>
                <th className="num">Debit</th>
                <th className="num">Credit</th>
              </tr>
            </thead>
            <tbody>
              {detail.ledger.map((l, i) => (
                <tr key={i}>
                  <td>{fmtDT(l.date || l.created_at)}</td>
                  <td>{l.reference || '—'}</td>
                  <td>{l.type || '—'}</td>
                  <td className="num">{l.debit_cents ? fmtMoney(l.debit_cents) : '—'}</td>
                  <td className="num">{l.credit_cents ? fmtMoney(l.credit_cents) : '—'}</td>
                </tr>
              ))}
              {detail.ledger.length === 0 && (
                <tr>
                  <td colSpan="5" className="empty-state">
                    No ledger entries.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <h3 style={{ marginTop: 16 }}>Laybys</h3>
          <table className="grid">
            <thead>
              <tr>
                <th>Ref</th>
                <th>Status</th>
                <th className="num">Total</th>
                <th className="num">Paid</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {detail.layaways.map((l) => (
                <tr key={l.id}>
                  <td>{l.doc_no}</td>
                  <td>{l.status}</td>
                  <td className="num">{fmtMoney(l.total_cents)}</td>
                  <td className="num">{fmtMoney(l.paid_cents)}</td>
                  <td className="num">{fmtMoney(l.total_cents - l.paid_cents)}</td>
                </tr>
              ))}
              {detail.layaways.length === 0 && (
                <tr>
                  <td colSpan="5" className="empty-state">
                    No laybys.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}
