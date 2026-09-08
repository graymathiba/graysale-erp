import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/Toast';

// View C — Platform Overview Metrics.
export default function PlatformMetrics() {
  const toast = useToast();
  const [m, setM] = useState(null);

  useEffect(() => {
    (async () => {
      try { setM(await api.get('/superadmin/overview')); }
      catch (e) { if (!e?.silent) toast.err(e.message); }
    })();
  }, []);

  if (!m) return <div className="loader"><span className="spinner" />Loading…</div>;

  return (
    <div className="ct-metrics">
      <div className="stat-cards">
        <Stat k="Active Companies" v={m.activeCompanies ?? 0} d={`${m.totalCompanies ?? 0} onboarded platforms`} tone="green" />
        <Stat k="Blocked Instances" v={m.blockedInstances ?? 0} d="Access suspended by admin" tone="red" />
        <Stat k="Expired Accounts" v={m.expiredAccounts ?? 0} d="License lapsed — renewal needed" tone="amber" />
        <Stat k="Pending Activation" v={m.pendingKeys ?? 0} d="Awaiting a product key" tone="violet" />
      </div>

      <div className="panel">
        <div className="panel-hd"><span>Product key inventory</span></div>
        <div className="ct-key-stats">
          <KStat k="Generated" v={m.totalGenerated ?? 0} tone="violet" />
          <KStat k="Redeemed" v={m.redeemed ?? 0} tone="green" />
          <KStat k="Unused" v={m.unused ?? 0} tone="blue" />
          <KStat k="Revoked" v={m.revoked ?? 0} tone="red" />
        </div>
        <div className="ct-progress">
          <div
            className="ct-progress-fill"
            style={{ width: `${m.totalGenerated ? Math.round(((m.redeemed ?? 0) / m.totalGenerated) * 100) : 0}%` }}
          />
        </div>
        <div className="ct-progress-caption">
          <span>{m.redeemed ?? 0} of {m.totalGenerated ?? 0} keys redeemed</span>
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

function KStat({ k, v, tone }) {
  return (
    <div className={`ct-kstat${tone ? ` tone-${tone}` : ''}`}>
      <div className="ct-kstat-v">{v}</div>
      <div className="ct-kstat-k">{k}</div>
    </div>
  );
}