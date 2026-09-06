import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { authStore, login as apiLogin, fetchMe, api } from '../api/client';

const AuthContext = createContext(null);

// Role -> set of permitted capabilities mirroring the backend permission matrix.
const CAPABILITIES = {
  owner: ['*'],
  manager: [
    'pos.sell', 'pos.refund', 'pos.layaway', 'pos.quote',
    'catalog.manage', 'inventory.adjust',
    'customers.manage', 'suppliers.manage',
    'purchasing.manage', 'invoicing.manage',
    'accounting.view', 'accounting.post',
    'reports.view', 'eod.self', 'eod.run',
    'users.view', 'users.manage', 'users.delete', 'settings.manage',
  ],
  accountant: ['accounting.view', 'accounting.post', 'reports.view', 'eod.view'],
  cashier: ['pos.sell', 'pos.refund', 'pos.layaway', 'eod.self'],
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => authStore.user);
  const [ready, setReady] = useState(!!authStore.token);

  useEffect(() => {
    if (authStore.token && !authStore.user) {
      fetchMe()
        .then((u) => { setUser(u); authStore.set({ token: authStore.token, user: u }); })
        .catch(() => { authStore.clear(); setUser(null); })
        .finally(() => setReady(true));
    } else {
      setReady(true);
    }

    // Central HTTP client signals a stale/expired session (single-shot).
    // Nulling the user drops every protected route back to /login.
    const onUnauthorized = () => { authStore.clear(); setUser(null); };
    window.addEventListener('app:unauthorized', onUnauthorized);
    return () => window.removeEventListener('app:unauthorized', onUnauthorized);
  }, []);

  const login = useCallback(async (u, p) => {
    const usr = await apiLogin(u, p);
    setUser(usr);
    return usr;
  }, []);

  const logout = useCallback(async () => {
    try { await api.post('/auth/logout'); } catch { /* ignore */ }
    authStore.clear();
    setUser(null);
  }, []);

  // capability check, honoring the backend's '*' wildcard.
  const can = useCallback((cap) => {
    if (!user) return false;
    const perms = CAPABILITIES[user.role];
    if (!perms) return false;
    if (perms.includes('*')) return true;
    return perms.includes(cap);
  }, [user]);

  const isAdmin = !!user && (user.role === 'owner' || user.role === 'manager');
  const isCashier = !!user && user.role === 'cashier';

  return (
    <AuthContext.Provider value={{ user, ready, login, logout, can, isAdmin, isCashier, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
