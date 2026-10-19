import { useState } from 'react';
import { useAuth } from '../../api/AuthContext';
import TenantsList from './TenantsList';
import KeyGenerator from './KeyGenerator';
import PlatformMetrics from './PlatformMetrics';

const TABS = [
  { key: 'overview', label: 'Overview', component: PlatformMetrics },
  { key: 'tenants', label: 'Company Tenants', component: TenantsList },
  { key: 'keys', label: 'Product Keys', component: KeyGenerator },
];

// Isolated platform-administration shell. Routes under /admin/control-tower are
// guarded for is_super_admin accounts only (see main.jsx) — normal GraySale
// tenant users never reach these sub-views.
export default function ControlTowerLayout() {
  const { user } = useAuth();
  const [tab, setTab] = useState('overview');
  const Active = TABS.find((t) => t.key === tab).component;

  return (
    <div className="page ct-page">
      <div className="page-hd">
        <div className="page-title">
          <h1>Control Tower</h1>
          <p>Platform-wide administration: company tenants, product keys and license health.</p>
        </div>
        <div className="ct-owner-chip">
          <span className="ct-owner-dot" />
          {user?.fullName || user?.username} · Platform Admin
        </div>
      </div>

      <div className="seg ct-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'seg-on' : ''} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <Active />
    </div>
  );
}
