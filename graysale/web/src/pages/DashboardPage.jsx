import { useEffect, useState } from 'react';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import { fmtMoney } from '../lib/format';

export default function DashboardPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [stats, setStats] = useState(null);
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        // Real financial aggregates (cash / mobile / AR / AP) + the weekly
        // sparkline & stock alerts from the dashboard report.
        const [s, d] = await Promise.all([api.get('/dashboard/stats'), api.get('/dashboard')]);
        setStats(s);
        setSummary(d);
      } catch (e) {
        if (e?.silent) return;
        toast.err(e.message);
      }
    })();
  }, []);

  if (!stats || !summary)
    return (
      <div className="loader">
        <span className="spinner" />
        Loading…
      </div>
    );

  const byDay = summary.byDay || [];
  const lowStock = summary.lowStock || [];
  const maxRow = Math.max(1, ...byDay.map((r) => r.sales || 0));

  return (
    <div className="page">
      <div className="page-hd">
        <div className="page-title">
          <h1>Dashboard</h1>
          <p>Welcome back, {user?.full_name || user?.username}. Here’s your store at a glance.</p>
        </div>
      </div>

      <div className="stat-cards">
        <Stat k="Gross Sales" v={fmtMoney(stats.grossSales ?? 0)} d={`${stats.totalSalesCount ?? 0} paid sale(s)`} />
        <Stat
          k="Net Revenue"
          v={fmtMoney(stats.totalRevenue ?? 0)}
          d={`${fmtMoney(stats.refunds ?? 0)} refunded`}
          tone="green"
        />
        <Stat
          k="Receivables (AR)"
          v={fmtMoney(stats.totalBalanceDue ?? 0)}
          d="Open invoices + layaways"
          tone="violet"
        />
        <Stat k="Payables (AP)" v={fmtMoney(stats.totalPayable ?? 0)} d="Owed to suppliers" tone="amber" />
        <Stat k="Cash in Drawer" v={fmtMoney(stats.cashTotal ?? 0)} d="Cash collected" tone="green" />
        <Stat k="Mobile / EcoCash" v={fmtMoney(stats.ecoCashTotal ?? 0)} d="EcoCash and mobile money" tone="violet" />
        <Stat k="Mobile Only" v={fmtMoney(stats.mobileTotal ?? 0)} d="Mobile money" tone="amber" />
        <Stat
          k="Low Stock"
          v={stats.lowStockCount ?? 0}
          d="Items below reorder level"
          tone={stats.lowStockCount ? 'red' : 'green'}
        />
      </div>

      <div className="two-col">
        <div className="panel">
          <div className="panel-hd">
            <span>Sales — last 7 days</span>
          </div>
          <div className="bars">
            {byDay.map((r) => {
              const val = r.sales || 0;
              const h = Math.max(3, Math.round((val / maxRow) * 140));
              return (
                <div className="bar-col" key={r.day}>
                  <div className="bar-val">{fmtMoney(val)}</div>
                  <div className="bar" style={{ height: h }} title={`${r.day}: ${fmtMoney(val)}`} />
                  <div className="bar-days">{String(r.day).slice(-2)}</div>
                </div>
              );
            })}
            {byDay.length === 0 && <div className="empty-state">No sales in the last 7 days.</div>}
          </div>
        </div>

        <div className="panel">
          <div className="panel-hd">
            <span>Low stock alerts</span>
          </div>
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
