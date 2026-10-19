import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './styles/theme.css';
import { AuthProvider, useAuth } from './api/AuthContext';
import { ToastProvider } from './components/Toast';
import AppShell from './components/AppShell';
import LoginPage from './pages/LoginPage';
import RegisterCompanyPage from './pages/RegisterCompanyPage';
import SetPasswordPage from './pages/SetPasswordPage';
import ActivateLicensePage from './pages/ActivateLicensePage';
import StorageSetupPage from './pages/StorageSetupPage';
import StoragePage from './pages/StoragePage';

import DashboardPage from './pages/DashboardPage';
import PosPage from './pages/PosPage';
import StockPage from './pages/StockPage';
import InvoicesPage from './pages/InvoicesPage';
import PurchasingPage from './pages/PurchasingPage';
import CustomersPage from './pages/CustomersPage';
import SuppliersPage from './pages/SuppliersPage';
import AccountingPage from './pages/AccountingPage';
import ReportsPage from './pages/ReportsPage';
import EodPage from './pages/EodPage';
import SettingsPage from './pages/SettingsPage';
import CompanySettingsPage from './pages/CompanySettingsPage';
import CompanyProfilePage from './pages/CompanyProfilePage';
import UsersPage from './pages/UsersPage';
import SupportPage from './pages/SupportPage';
import ControlTowerLayout from './pages/controlTower/ControlTowerLayout';
import { api } from './api/client';

function RequireAuth({ children }) {
  const { user, ready } = useAuth();
  if (!ready) {
    return (
      <div className="loader">
        <span className="spinner" />
        Loading…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

// Strict Control Tower guard: only accounts carrying the global
// is_super_admin flag may render the platform-administration panel.
function RequireSuperAdmin({ children }) {
  const { user, ready } = useAuth();
  if (!ready)
    return (
      <div className="loader">
        <span className="spinner" />
        Loading…
      </div>
    );
  if (!user) return <Navigate to="/login" replace />;
  if (!user.isSuperAdmin) return <Navigate to="/dashboard" replace />;
  return children;
}

function RequireGuest({ children }) {
  const { user, ready } = useAuth();
  if (!ready)
    return (
      <div className="loader">
        <span className="spinner" />
        Loading…
      </div>
    );
  if (user) return <Navigate to="/dashboard" replace />;
  return children;
}

// A tenant that still needs activation may only visit the activation gate.
// Every ERP page sits behind this wall so nothing can run unlicensed.
function RequireActiveTenant({ children }) {
  const { needsActivation } = useAuth();
  if (needsActivation) return <Navigate to="/activate-license" replace />;
  return children;
}

// Storage gate: until the backend confirms the data folder is configured for
// this machine, everything redirects to /setup. A fetch failure is treated as
// "ready" so development builds without the storage layer keep working.
function RequireStorage({ children }) {
  const [state, setState] = React.useState('checking');
  const [err, setErr] = React.useState('');
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await api.get('/setup/status', { skipAuthGuard: true });
        if (!alive) return;
        setState(d.storage.phase === 'ready' ? 'ready' : 'setup');
      } catch (e) {
        if (!alive) return;
        setErr(e.message);
        setState('ready');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (state === 'checking') {
    return (
      <div className="loader">
        <span className="spinner" />
        Checking storage…
      </div>
    );
  }
  if (state === 'setup') return <Navigate to="/setup" replace />;
  // On transient fetch failure we DON'T brick the app: show a warning banner
  // and render the children anyway so POS / reports keep working offline.
  if (err) {
    return (
      <>
        <div className="storage-warn" role="alert">
          Storage check failed ({err}) — data may be remote. Continue below.
        </div>
        {children}
      </>
    );
  }
  return children;
}

function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route
              path="/login"
              element={
                <RequireGuest>
                  <LoginPage />
                </RequireGuest>
              }
            />
            <Route
              path="/register"
              element={
                <RequireGuest>
                  <RegisterCompanyPage />
                </RequireGuest>
              }
            />
            <Route
              path="/set-password"
              element={
                <RequireAuth>
                  <SetPasswordPage />
                </RequireAuth>
              }
            />
            <Route path="/setup" element={<StorageSetupPage />} />
            <Route
              path="/activate-license"
              element={
                <RequireAuth>
                  <ActivateLicensePage />
                </RequireAuth>
              }
            />
            <Route
              element={
                <RequireStorage>
                  <RequireAuth>
                    <RequireActiveTenant>
                      <AppShell />
                    </RequireActiveTenant>
                  </RequireAuth>
                </RequireStorage>
              }
            >
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/pos" element={<PosPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/accounting" element={<AccountingPage />} />
              <Route path="/purchasing" element={<PurchasingPage />} />
              <Route path="/invoices" element={<InvoicesPage />} />
              <Route path="/stock" element={<StockPage />} />
              <Route path="/customers" element={<CustomersPage />} />
              <Route path="/suppliers" element={<SuppliersPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/eod" element={<EodPage />} />
              <Route path="/storage" element={<StoragePage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/company" element={<CompanySettingsPage />} />
              <Route path="/company-profile" element={<CompanyProfilePage />} />
              <Route path="/users" element={<UsersPage />} />
              <Route path="/support" element={<SupportPage />} />
              <Route
                path="/admin/control-tower/*"
                element={
                  <RequireSuperAdmin>
                    <ControlTowerLayout />
                  </RequireSuperAdmin>
                }
              />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
