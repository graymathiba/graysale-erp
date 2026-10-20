import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './styles/theme.css';
import { AuthProvider, useAuth } from './api/AuthContext';
import { ToastProvider } from './components/Toast';
import LoginPage from './pages/LoginPage';
import RegisterCompanyPage from './pages/RegisterCompanyPage';
import SetPasswordPage from './pages/SetPasswordPage';
import ActivateLicensePage from './pages/ActivateLicensePage';
import StorageSetupPage from './pages/StorageSetupPage';
import StoragePage from './pages/StoragePage';
import DocumentPrintPage from './pages/DocumentPrintPage';

import DashboardPage from './pages/DashboardPage';
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
import DesktopShell from './components/DesktopShell';
import DesktopHomePage from './pages/DesktopHomePage';
import DesktopPOSPage from './pages/DesktopPOSPage';
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

function RequireGuest({ children }) {
  const { user, ready } = useAuth();
  if (!ready)
    return (
      <div className="loader">
        <span className="spinner" />
        Loading…
      </div>
    );
  if (user) return <Navigate to="/desktop" replace />;
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

// Legacy Modern-UI URLs (pre-desktop build) land on their Classic Desktop
// equivalent so old bookmarks and printed links never 404.
const LEGACY_REDIRECTS = {
  '/pos': '/desktop/pos',
  '/dashboard': '/desktop/dashboard',
  '/stock': '/desktop/stock',
  '/customers': '/desktop/customers',
  '/suppliers': '/desktop/suppliers',
  '/purchasing': '/desktop/purchasing',
  '/invoices': '/desktop/invoices',
  '/accounting': '/desktop/accounting',
  '/reports': '/desktop/reports',
  '/eod': '/desktop/eod',
  '/settings': '/desktop/settings',
  '/users': '/desktop/users',
  '/storage': '/desktop/storage',
  '/company': '/desktop/company',
  '/company-profile': '/desktop/company-profile',
  '/support': '/desktop/support',
  '/admin/control-tower': '/desktop',
};

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
            {/* Full-page A4 document printer (quotes / invoices / orders). */}
            <Route
              path="/print/doc/:kind/:id"
              element={
                <RequireAuth>
                  <DocumentPrintPage />
                </RequireAuth>
              }
            />
            {Object.entries(LEGACY_REDIRECTS).map(([from, to]) => (
              <Route key={from} path={from} element={<Navigate to={to} replace />} />
            ))}

            {/* ============ Classic Desktop — the only ERP workspace ============ */}
            <Route
              element={
                <RequireStorage>
                  <RequireAuth>
                    <RequireActiveTenant>
                      <DesktopShell />
                    </RequireActiveTenant>
                  </RequireAuth>
                </RequireStorage>
              }
            >
              <Route path="/" element={<Navigate to="/desktop" replace />} />
              <Route path="/desktop" element={<DesktopHomePage />} />
              <Route path="/desktop/pos" element={<DesktopPOSPage />} />
              <Route path="/desktop/dashboard" element={<DashboardPage />} />
              <Route path="/desktop/stock" element={<StockPage />} />
              <Route path="/desktop/customers" element={<CustomersPage />} />
              <Route path="/desktop/suppliers" element={<SuppliersPage />} />
              <Route path="/desktop/purchasing" element={<PurchasingPage />} />
              <Route path="/desktop/invoices" element={<InvoicesPage />} />
              <Route path="/desktop/accounting" element={<AccountingPage />} />
              <Route path="/desktop/reports" element={<ReportsPage />} />
              <Route path="/desktop/eod" element={<EodPage />} />
              <Route path="/desktop/settings" element={<SettingsPage />} />
              <Route path="/desktop/company" element={<CompanySettingsPage />} />
              <Route path="/desktop/users" element={<UsersPage />} />
              <Route path="/desktop/storage" element={<StoragePage />} />
              <Route path="/desktop/company-profile" element={<CompanyProfilePage />} />
              <Route path="/desktop/support" element={<SupportPage />} />
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
