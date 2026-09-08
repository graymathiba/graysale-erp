import { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../api/AuthContext';
import { NAV_GROUPS, findNavItem } from '../lib/nav';
import { initials } from '../lib/format';

export default function AppShell() {
  const { user, logout, can, isSuperAdmin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [globalSearch, setGlobalSearch] = useState('');

  const loc = findNavItem(location.pathname) || {};
  const group = loc.group || '';
  const leaf = loc.item?.label || (location.pathname === '/login' ? 'Login' : 'Home');

  const handleSearch = (e) => {
    if (e.key !== 'Enter') return;
    const q = globalSearch.trim();
    if (!q) return;
    // Route searches to the customers or stock page based on prefix, else POS.
    if (/^c[@]?\s/i.test(q)) navigate(`/customers?q=${encodeURIComponent(q.replace(/^c[@]?\s/i, ''))}`);
    else navigate(`/pos?q=${encodeURIComponent(q)}`);
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-scroll">
          {NAV_GROUPS.map((g) => (
            <div className="side-group" key={g.title}>
              <div className="side-group-title">{g.title}</div>
              {g.items
                .filter((it) => !it.super ? (!it.cap || can(it.cap)) : isSuperAdmin)
                .map((it) => (
                  <button
                    key={it.key}
                    className={`side-item${location.pathname === it.route ? ' active' : ''}${it.super ? ' super-admin' : ''}`}
                    onClick={() => navigate(it.route)}
                    title={it.label}
                  >
                    <span className="label">{it.label}</span>
                  </button>
                ))}
            </div>
          ))}
        </div>
        <button className="side-collapse-btn" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? '»' : '«'}
        </button>
        <div className="side-profile">
          <div className="avatar">{initials(user?.fullName || user?.username)}</div>
          <div className="who">
            <div className="nm">{user?.fullName || user?.username}</div>
            <div className="em">{user?.username} · {user?.role}</div>
          </div>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark">GS</span>
            <span className="brand-name">GraySale <span>ERP</span></span>
          </div>

          <div className="breadcrumb">
            <span>Home</span>
            {group && <span className="sep">/</span>}
            {group && <span className="group">{group}</span>}
            <span className="sep">/</span>
            <span className="leaf">{leaf}</span>
          </div>

          <div className="topbar-grow" />

          <input
            className="search-input"
            style={{ minWidth: 200 }}
            placeholder="Global search — scan barcode / SKU / customer…"
            value={globalSearch}
            onChange={(e) => setGlobalSearch(e.target.value)}
            onKeyDown={handleSearch}
          />

          <div className="tb-action">
            <button className="btn btn-primary" onClick={() => navigate('/pos')}>New Sale</button>
          </div>

          <button className="btn btn-ghost" onClick={logout}>Log out</button>
        </header>

        <div className="content-scroll">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
