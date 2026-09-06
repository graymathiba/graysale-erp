import { useEffect, useState } from 'react';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import DataTable from '../components/DataTable';
import { fmtMoney } from '../lib/format';

export default function ReportsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [summary, setSummary] = useState(null);
  const [top, setTop] = useState([]);
  const [byDay, setByDay] = useState([]);
  const [cashiers, setCashiers] = useState([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => { load(); }, []);

  const load = async (f = from, t = to) => {
    const qs = new URLSearchParams();
    if (f) qs.set('from', f);
    if (t) qs.set('to', t);
    const q = qs.toString();
    try { setSummary(await api.get(`/reports/summary${q ? '?' + q : ''}`)); } catch (e) { if (e?.silent) return; toast.err(e.message); }
    try { const r = await api.get(`/reports/top-products${q ? '?' + q : ''}`); setTop(Array.isArray(r) ? r : r.rows || []); } catch (e) { /* */ }
    try { const r = await api.get(`/reports/by-day${q ? '?' + q : ''}`); setByDay(Array.isArray(r) ? r : r.rows || []); } catch (e) { /* */ }
    try { const r = await api.get(`/reports/cashiers${q ? '?' + q : ''}`); setCashiers(Array.isArray(r) ? r : r.rows || []); } catch (e) { /* */ }
  };

  if (!can('reports.view')) {
    return <div className="panel"><div className="empty-state">Sales analysis is available to manager / finance roles.</div></div>;
  }

  const s = summary || {};
  const maxRow = Math.max(1, ...byDay.map((r) => r.total_cents || 0));

  const topCols = [
    { key: 'name', label: 'Product' },
    { key: 'qty', label: 'Qty', num: true, render: (r) => r.qty ?? r.units ?? 0 },
    { key: 'rev', label: 'Revenue', num: true, render: (r) => fmtMoney(r.total_cents ?? 0) },
  ];
  const cashierCols = [
    { key: 'user', label: 'Cashier', render: (r) => r.full_name || r.username || '—' },
    { key: 'sales', label: 'Sales', num: true, render: (r) => r.count ?? 0 },
    { key: 'total', label: 'Total', num: true, render: (r) => fmtMoney(r.total_cents ?? 0) },
  ];

  return (
    <div className="page">
      <div className="page-hd">
        <div className="page-title"><h1>Sales Analysis</h1><p>Performance and trends.</p></div>
      </div>

      <div className="toolbar">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="muted">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="btn btn-primary" onClick={() => load(from, to)}>Apply</button>
      </div>

      <div className="stat-cards">
        <Stat label="Sales" value={fmtMoney(s.total)} />
        <Stat label="Transactions" value={s.count ?? 0} />
        <Stat label="Units" value={s.units ?? 0} />
        <Stat label="Cash in" value={fmtMoney(s.cashIn ?? 0)} />
      </div>

      <div className="two-col">
        <div className="panel">
          <div className="panel-hd"><span>Sales by day</span></div>
          <div className="bars">
            {byDay.map((r) => (
              <div className="bar-col" key={r.dd}>
                <div className="bar" style={{ height: Math.round((r.total_cents / maxRow) * 120) }} title={fmtMoney(r.total_cents)} />
                <div className="bar-days">{r.dd}</div>
              </div>
            ))}
            {byDay.length === 0 && <div className="empty-state">No sales in range.</div>}
          </div>
        </div>
        <DataTable columns={topCols} rows={top} rowKey={(r, i) => i} empty="No data"
          caption={<div className="table-capt"><span>Top products</span></div>} />
      </div>

      <DataTable columns={cashierCols} rows={cashiers} rowKey={(r, i) => i} empty="No data"
        caption={<div className="table-capt"><span>Cashier performance</span></div>} />
    </div>
  );
}

function Stat({ label, value }) {
  return <div className="stat"><div className="stat-tx"><div className="stat-val">{value}</div><div className="stat-lab">{label}</div></div></div>;
}
