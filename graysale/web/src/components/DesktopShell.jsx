import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../api/AuthContext';
import { DESKTOP_MENUS, DESKTOP_SHORTCUTS } from '../lib/desktopNav';
import { initials } from '../lib/format';
import DesktopIcon from './DesktopIcons';
import DesktopWindow from './DesktopWindow';
import { HardwareSetupPanel, ActivityLogPanel, CalculatorPanel, StubPanel, AboutPanel } from './DesktopPanels';
import '../styles/desktop.css';

const nowHM = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export default function DesktopShell() {
  const { user, tenant, logout, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [openMenu, setOpenMenu] = useState(null);
  const [win, setWin] = useState(null); // { kind, label? } | null
  const [locked, setLocked] = useState(false);
  const [clock, setClock] = useState(nowHM());
  const menuRef = useRef(null);

  useEffect(() => {
    const t = setInterval(() => setClock(nowHM()), 30000);
    return () => clearInterval(t);
  }, []);

  // Route changes and Escape always fold the menu back up.
  useEffect(() => {
    setOpenMenu(null);
  }, [location.pathname]);
  useEffect(() => {
    if (!openMenu) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpenMenu(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [openMenu]);

  const company = tenant?.company_name || tenant?.company || '';
  const who = user?.full_name || user?.username || '?';

  const runAction = (action) => {
    setOpenMenu(null);
    if (action === 'modern') {
      navigate('/dashboard');
      return;
    }
    if (action.startsWith('stub:')) {
      setWin({ kind: 'stub', label: action.slice(5) });
      return;
    }
    setWin({ kind: action });
  };

  const go = (item) => {
    setOpenMenu(null);
    if (item.route) navigate(item.route);
    else if (item.action) runAction(item.action);
  };

  const closeWin = () => setWin(null);

  return (
    <div className="dsk">
      {/* ============ TITLE BAR ============ */}
      <div className="dsk-title">
        <DesktopIcon name="monitor" size={15} />
        <span className="dsk-title-txt">
          GraySale Classic — {company || 'ERP'}
          {' ( '}
          {who}
          {' )'}
        </span>
        <span className="dsk-clock">{clock}</span>
        <div className="dsk-title-acts">
          <button className="dsk-title-btn" title="Lock screen" onClick={() => setLocked(true)}>
            <DesktopIcon name="lock" size={14} />
          </button>
          <button className="dsk-title-btn" title="About GraySale" onClick={() => setWin({ kind: 'about' })}>
            <DesktopIcon name="info" size={14} />
          </button>
          <button className="dsk-title-btn" title="Switch to Modern UI" onClick={() => navigate('/dashboard')}>
            <DesktopIcon name="door" size={14} />
          </button>
        </div>
      </div>

      {/* ============ MENU BAR ============ */}
      <div className="dsk-menu" ref={menuRef}>
        {DESKTOP_MENUS.map((m) => {
          const items = m.items.filter((it) => !it.cap || can(it.cap));
          if (!items.length) return null;
          const open = openMenu === m.title;
          return (
            <div key={m.title} className={`dsk-menu-item${open ? ' open' : ''}`}>
              <button
                className="dsk-menu-btn"
                onClick={() => setOpenMenu(open ? null : m.title)}
                onMouseEnter={() => {
                  if (openMenu) setOpenMenu(m.title);
                }}
              >
                {m.title}
              </button>
              {open ? (
                <div className="dsk-menu-dd">
                  {items.map((it) => (
                    <button key={it.label} onClick={() => go(it)}>
                      <DesktopIcon name={it.icon || 'grid'} size={14} />
                      {it.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* ============ WORKSPACE ============ */}
      <div className="dsk-work">
        <div className="dsk-tools">
          {DESKTOP_SHORTCUTS.filter((s) => !s.cap || can(s.cap)).map((s) => (
            <button key={s.key} className="dsk-tool" onClick={() => go(s)} title={s.label}>
              <DesktopIcon name={s.icon || 'grid'} size={24} />
              <span>{s.label}</span>
            </button>
          ))}
        </div>

        <div className="dsk-doc">
          <Outlet />
        </div>

        {win?.kind === 'hardware' ? (
          <DesktopWindow title="Hardware Setup" icon="wrench" width={470} docked onClose={closeWin}>
            <HardwareSetupPanel onClose={closeWin} />
          </DesktopWindow>
        ) : null}
        {win?.kind === 'activity' ? (
          <DesktopWindow title="Activity Log" icon="log" width={560} docked onClose={closeWin}>
            <ActivityLogPanel onClose={closeWin} />
          </DesktopWindow>
        ) : null}
        {win?.kind === 'calculator' ? (
          <DesktopWindow title="Calculator" icon="calculator" width={250} onClose={closeWin}>
            <CalculatorPanel onClose={closeWin} />
          </DesktopWindow>
        ) : null}
        {win?.kind === 'about' ? (
          <DesktopWindow title="About GraySale" icon="info" width={330} onClose={closeWin}>
            <AboutPanel company={company} username={who} onClose={closeWin} />
          </DesktopWindow>
        ) : null}
        {win?.kind === 'stub' ? (
          <DesktopWindow title={win.label || 'Module'} icon="info" width={380} onClose={closeWin}>
            <StubPanel label={win.label} onClose={closeWin} />
          </DesktopWindow>
        ) : null}
      </div>

      {/* ============ LOCK OVERLAY ============ */}
      {locked ? (
        <div className="dsk-lock" role="dialog" aria-label="Session locked">
          <div className="dsk-lock-card">
            <span className="avatar">{initials(who)}</span>
            <h3>Session locked</h3>
            <div className="muted">{who}</div>
            <div className="dsk-lock-acts">
              <button className="btn btn-primary" onClick={() => setLocked(false)}>
                Unlock
              </button>
              <button className="btn" onClick={() => logout()}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
