import { useEffect, useState } from 'react';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import { fmtMoney } from '../lib/format';

export default function DashboardPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);

  useEffect(() => {
    (async () => {
      try { setData(await api.get('/dashboard')); }
      catch (e) { if (e?.silent) return; toast.err(e.message); }
    })();
  }, []);

  if (!data) return <div className="loader"><span className="spinner" />Loading…</div>;

  const today = data.today || {};
  const byDay = data.byDay || [];
  const lowStock = data.lowStock || [];
  const maxRow = Math.max(1, ...byDay.map((r) => r.sales || 0));

  return (
    <div className="page">
      <div className="page-hd">
        <div className="page-title">
          <h1>Dashboard</h1>
          <p>Welcome back, {user?.full_name || user?.username}. Here’s today at a glance.</p>
        </div>
      </div>

      <div className="stat-cards">
        <Stat k="Today’s Sales" v={fmtMoney(today.grossSales ?? 0)} d={`${today.saleCount ?? 0} paid sale(s) today`} />
        <Stat k="Transactions" v={today.saleCount ?? 0} d="POS sales today" tone="violet" />
        <Stat k="Units Sold" v={today.units ?? 0} d="Quantity out today" tone="green" />
        <Stat k="Net Sales" v={fmtMoney(today.netSales ?? 0)} d="After refunds" tone="amber" />
      </div>

      <div className="two-col">
        <div className="panel">
          <div className="panel-hd"><span>Sales — last 7 days</span></div>
          <div className="bars">
            {byDay.map((r) => {
              const val = r.sales || 0;
              const h = Math.max(3, Math.round((val / maxRow) * 150));
              return (
                <div className="bar-col" key={r.day}>
                  <div className="bar" style={{ height: h }} title={`${r.day}: ${fmtMoney(val)}`} />
                  <div className="bar-days">{String(r.day).slice(-2)}</div>
                </div>
              );
            })}
            {byDay.length === 0 && <div className="empty-state">No sales in the last 7 days.</div>}
          </div>
        </div>

        <div className="panel">
          <div className="panel-hd"><span>Low stock alerts</span></div>
          <div className="lows">
            {lowStock.map((p) => (
              <div className="low-row" key={p.id}>
                <span className="nm">{p.name}</span>
                <span className={`qt ${p.qty_on_hand <= (p.reorder_level || 0) ? 'danger' : 'muted'}`}>
                  {p.qty_on_hand ?? 0} left
                </span>
              </div>
            ))}
            {lowStock.length === 0 && <div className="empty-state">All stock levels healthy.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ k, v, d, tone }) {
  return (
    <div className={`stat-card${tone ? ` tone-${tone}` : ''}`}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {d && <div className="d">{d}</div>}
    </div>
  );
}