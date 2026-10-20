import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { authStore, login as apiLogin, fetchMe, api } from '../api/client';

const AuthContext = createContext(null);

// Role -> set of permitted capabilities mirroring the backend permission matrix.
const CAPABILITIES = {
  owner: ['*'],
  manager: [
    'pos.sell',
    'pos.refund',
    'pos.layaway',
    'pos.quote',
    'catalog.manage',
    'inventory.adjust',
    'customers.manage',
    'suppliers.manage',
    'purchasing.manage',
    'invoicing.manage',
    'accounting.view',
    'accounting.post',
    'reports.view',
    'eod.self',
    'eod.run',
    'users.view',
    'users.manage',
    'users.delete',
    'settings.manage',
  ],
  accountant: ['accounting.view', 'accounting.post', 'reports.view', 'eod.view'],
  cashier: ['pos.sell', 'pos.refund', 'pos.layaway', 'eod.self'],
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => authStore.user);
  const [tenant, setTenant] = useState(() => authStore.tenant);
  const [ready, setReady] = useState(!!authStore.token);

  useEffect(() => {
    if (authStore.token && !authStore.user) {
      fetchMe()
        .then(({ user: u, tenant: t }) => {
          setUser(u);
          setTenant(t);
          authStore.set({ token: authStore.token, user: u, tenant: t });
        })
        .catch(() => {
          authStore.clear();
          setUser(null);
          setTenant(null);
        })
        .finally(() => setReady(true));
    } else if (authStore.token) {
      // Warm session: the identity is already cached, but the tenant snapshot
      // in localStorage can be stale (e.g. activated in another tab, or the
      // key was redeemed after this session was created). Refresh it in the
      // background so needsActivation cannot loop against a frozen status.
      fetchMe()
        .then(({ user: u, tenant: t }) => {
          setUser(u);
          setTenant(t);
          authStore.set({ token: authStore.token, user: u, tenant: t });
        })
        .catch(() => {
          // Silently keep the optimistic session; the first real API call
          // runs the standard 401 interceptor if the token is dead.
        });
      setReady(true);
    } else {
      setReady(true);
    }

    // Central HTTP client signals a stale/expired session (single-shot).
    // Nulling the user drops every protected route back to /login.
    const onUnauthorized = () => {
      authStore.clear();
      setUser(null);
      setTenant(null);
    };
    window.addEventListener('app:unauthorized', onUnauthorized);
    return () => window.removeEventListener('app:unauthorized', onUnauthorized);
  }, []);

  const login = useCallback(async (u, p) => {
    const { user: usr, tenant: tnt, requiresPasswordChange } = await apiLogin(u, p);
    setUser(usr);
    setTenant(tnt);
    return { user: usr, tenant: tnt, requiresPasswordChange };
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* ignore */
    }
    authStore.clear();
    setUser(null);
    setTenant(null);
  }, []);

  // Re-pull the authenticated identity + tenant from the backend. Used right
  // after a license key is redeemed so the pending->active switch reflects
  // immediately in the UI.
  const refreshTenant = useCallback(async () => {
    const { user: u, tenant: t } = await fetchMe();
    setUser(u);
    setTenant(t);
    authStore.set({ token: authStore.token, user: u, tenant: t });
    return t;
  }, []);

  // PENDING_KEY / PENDING_ACTIVATION / BLOCKED tenants must activate (or
  // renew) before the ERP opens; drives RequireActiveTenant.
  const needsActivation = !!tenant && ['PENDING_KEY', 'PENDING_ACTIVATION', 'BLOCKED'].includes(tenant.status);

  // capability check, honoring the backend's '*' wildcard.
  const can = useCallback(
    (cap) => {
      if (!user) return false;
      const perms = CAPABILITIES[user.role];
      if (!perms) return false;
      if (perms.includes('*')) return true;
      return perms.includes(cap);
    },
    [user],
  );

  const isAdmin = !!user && (user.role === 'owner' || user.role === 'manager');
  const isCashier = !!user && user.role === 'cashier';

  return (
    <AuthContext.Provider
      value={{
        user,
        tenant,
        ready,
        login,
        logout,
        can,
        isAdmin,
        isCashier,
        needsActivation,
        refreshTenant,
        setUser,
        setTenant,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
