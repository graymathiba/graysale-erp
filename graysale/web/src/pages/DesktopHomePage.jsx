import { useNavigate } from 'react-router-dom';
import { useAuth } from '../api/AuthContext';
import { DESKTOP_SHORTCUTS } from '../lib/desktopNav';
import DesktopIcon from '../components/DesktopIcons';
import '../styles/desktop.css';

export default function DesktopHomePage() {
  const navigate = useNavigate();
  const { user, tenant, can } = useAuth();
  const company = tenant?.company_name || tenant?.company || 'GraySale ERP';
  const who = user?.full_name || user?.username || '';

  return (
    <div className="dsk-home">
      <div className="dsk-home-hd">
        <h2>{company}</h2>
        <div className="sub">Welcome, {who} — pick a module below or use the menu bar above.</div>
      </div>
      <div className="dsk-home-grid">
        {DESKTOP_SHORTCUTS.filter((s) => s.route && (!s.cap || can(s.cap))).map((s) => (
          <button key={s.key} className="dsk-home-tile" onClick={() => navigate(s.route)}>
            <DesktopIcon name={s.icon || 'grid'} size={22} />
            {s.label}
          </button>
        ))}
        {user?.isSuperAdmin && (
          <button className="dsk-home-tile" onClick={() => navigate('/admin/control-tower')}>
            <DesktopIcon name="monitor" size={22} />
            Control Tower
          </button>
        )}
      </div>
    </div>
  );
}
