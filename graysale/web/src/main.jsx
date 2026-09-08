import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './styles/theme.css';
import { AuthProvider, useAuth } from './api/AuthContext';
import { ToastProvider } from './components/Toast';
import AppShell from './components/AppShell';
import LoginPage from './pages/LoginPage';
import ActivateLicensePage from './pages/ActivateLicensePage';

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

function RequireAuth({ children }) {
  const { user, ready } = useAuth();
  if (!ready) {
    return <div className="loader"><span className="spinner" />Loading…</div>;
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

// Strict Control Tower guard: only accounts carrying the global
// is_super_admin flag may render the platform-administration panel.
function RequireSuperAdmin({ children }) {
  const { user, ready } = useAuth();
  if (!ready) return <div className="loader"><span className="spinner" />Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.isSuperAdmin) return <Navigate to="/dashboard" replace />;
  return children;
}

function RequireGuest({ children }) {
  const { user, ready } = useAuth();
  if (!ready) return <div className="loader"><span className="spinner" />Loading…</div>;
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

function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<RequireGuest><LoginPage /></RequireGuest>} />
            <Route path="/activate-license" element={<RequireAuth><ActivateLicensePage /></RequireAuth>} />
            <Route element={<RequireAuth><RequireActiveTenant><AppShell /></RequireActiveTenant></RequireAuth>}>
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
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/company" element={<CompanySettingsPage />} />
              <Route path="/company-profile" element={<CompanyProfilePage />} />
              <Route path="/users" element={<UsersPage />} />
            <Route path="/support" element={<SupportPage />} />
            <Route path="/admin/control-tower/*" element={<RequireSuperAdmin><ControlTowerLayout /></RequireSuperAdmin>} />
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
  </React.StrictMode>
);
