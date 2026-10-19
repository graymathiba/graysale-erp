import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../api/AuthContext';
import { Badge } from '../components/DataTable';

function fmtBytes(n) {
  if (!Number(n)) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}

function shortPath(p) {
  if (!p) return '—';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `…\\${parts.slice(-3).join('\\')}` : p;
}

const TENANT_LABELS = {
  users: 'Users',
  settings: 'Settings',
  product_categories: 'Categories',
  products: 'Products',
  customers: 'Customers',
  suppliers: 'Suppliers',
  orders: 'Orders',
  ar_invoices: 'Invoices',
  ap_bills: 'Bills',
  payments: 'Payments',
  company_settings: 'Company',
};

export default function StoragePage() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await api.get('/storage/status');
        if (alive) setData(d);
      } catch (e) {
        if (alive) setErr(e.message);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (err) return <div className="alert alert-err">{err}</div>;
  if (!data)
    return (
      <div className="loader">
        <span className="spinner" />
        Reading storage…
      </div>
    );

  const st = data.storage;
  const view = data.fileView;
  const phaseOk = st.phase === 'ready';

  return (
    <div className="page">
      <div className="page-hd">
        <div className="page-title">
          <h1>Data Storage</h1>
          <p>Where this GraySale lives, and what is actually inside the data folder.</p>
        </div>
        <Badge status={phaseOk ? 'ACTIVE' : 'BLOCKED'}>{phaseOk ? 'Ready' : st.phase}</Badge>
      </div>

      <div className="stat-cards">
        <div className="stat-card">
          <span className="stat-lab">Data folder</span>
          <span className="stat-val mono">{shortPath(view.root)}</span>
        </div>
        <div className="stat-card">
          <span className="stat-lab">Database size</span>
          <span className="stat-val">{fmtBytes(view.dbSize)}</span>
        </div>
        <div className="stat-card">
          <span className="stat-lab">Tables</span>
          <span className="stat-val">{view.tables.length}</span>
        </div>
        <div className="stat-card">
          <span className="stat-lab">Files in folder</span>
          <span className="stat-val">{view.files.filter((f) => !f.dir).length}</span>
        </div>
      </div>

      <div className="fields-2" style={{ marginTop: 16 }}>
        <div className="panel panel-bd" style={{ padding: 16 }}>
          <div className="panel-hd">
            <h3>Environment</h3>
          </div>
          <div className="setup-row">
            <span className="setup-lbl">This machine</span>
            <span className="setup-val mono">{st.machine?.label}</span>
          </div>
          <div className="setup-row">
            <span className="setup-lbl">Fingerprint</span>
            <span className="setup-val mono">{st.machine?.machineId}</span>
          </div>
          <div className="setup-row">
            <span className="setup-lbl">Storage kind</span>
            <span className="setup-val">{st.storage?.kind || 'local'}</span>
          </div>
          <div className="setup-row">
            <span className="setup-lbl">Descriptor</span>
            <span className="setup-val mono">{st.storage?.descriptor ? shortPath(st.storage.descriptor) : 'none'}</span>
          </div>
          {st.installedBy && (
            <div className="setup-row">
              <span className="setup-lbl">Created by</span>
              <span className="setup-val">
                {st.installedBy.hostname || '?'} · {new Date(st.installedBy.date).toLocaleString()}
              </span>
            </div>
          )}
        </div>

        <div className="panel panel-bd" style={{ padding: 16 }}>
          <div className="panel-hd">
            <h3>This tenant in storage</h3>
          </div>
          {data.myTenant ? (
            <table className="grid" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Table</th>
                  <th className="num">Rows</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.myTenant.counts).map(([name, rows]) => (
                  <tr key={name}>
                    <td>{TENANT_LABELS[name] || name}</td>
                    <td className="num">{rows}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No tenant context — every company shares this single database file.</p>
          )}
        </div>
      </div>

      <div className="panel panel-bd" style={{ padding: 16, marginTop: 16 }}>
        <div className="panel-hd">
          <h3>Database tables</h3>
          <span className="muted">
            {view.tables.length} tables · {fmtBytes(view.dbSize)}
          </span>
        </div>
        <table className="grid" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Table</th>
              <th className="num">Rows</th>
            </tr>
          </thead>
          <tbody>
            {view.tables.map((t) => (
              <tr key={t.name}>
                <td className="mono">{t.name}</td>
                <td className="num">{t.rows}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {view.tenants.length > 0 && (
        <div className="panel panel-bd" style={{ padding: 16, marginTop: 16 }}>
          <div className="panel-hd">
            <h3>Companies on this machine</h3>
            <span className="muted">per-tenant row counts</span>
          </div>
          <table className="grid" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Company</th>
                <th>Status</th>
                {Object.keys(TENANT_LABELS).map((l) => (
                  <th key={l} className="num">
                    {TENANT_LABELS[l]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.tenants.map((t) => (
                <tr key={t.tenant_id}>
                  <td>{t.company_name}</td>
                  <td>
                    <Badge status={t.status}>{t.status}</Badge>
                  </td>
                  {Object.entries(TENANT_LABELS).map(([name]) => (
                    <td key={name} className="num">
                      {t.counts[name] ?? 0}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel panel-bd" style={{ padding: 16, marginTop: 16 }}>
        <div className="panel-hd">
          <h3>Folder contents</h3>
        </div>
        <table className="grid" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">Size</th>
            </tr>
          </thead>
          <tbody>
            {view.files.map((f) => (
              <tr key={f.name}>
                <td className="mono">
                  {f.name}
                  {f.dir ? '\\' : ''}
                </td>
                <td className="num">{f.dir ? '—' : fmtBytes(f.size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint" style={{ marginTop: 8 }}>
          Signed in as {user?.username} · this report is read-only.
        </p>
      </div>
    </div>
  );
}
