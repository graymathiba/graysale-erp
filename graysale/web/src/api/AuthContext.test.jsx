import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext.jsx';

vi.mock('./client', () => {
  const store = {
    token: '',
    user: null,
    tenant: null,
    set({ token, user, tenant }) {
      store.token = token;
      store.user = user;
      if (tenant) store.tenant = tenant;
    },
    clear() {
      store.token = '';
      store.user = null;
      store.tenant = null;
    },
  };
  return {
    authStore: store,
    login: vi.fn(),
    fetchMe: vi.fn(),
    api: { post: vi.fn(), get: vi.fn() },
  };
});

const { authStore, login: apiLogin, fetchMe, api } = await import('./client');

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="ready">{String(auth.ready)}</span>
      <span data-testid="user">{auth.user ? auth.user.role : 'none'}</span>
      <span data-testid="can-settings">{String(auth.can('settings.manage'))}</span>
      <span data-testid="can-sell">{String(auth.can('pos.sell'))}</span>
      <span data-testid="needs-activation">{String(auth.needsActivation)}</span>
      <span data-testid="admin">{String(auth.isAdmin)}</span>
      <button onClick={() => auth.login('admin', 'pw')}>in</button>
      <button onClick={() => auth.logout()}>out</button>
    </div>
  );
}

const renderAuth = () =>
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );

beforeEach(() => {
  authStore.clear();
  apiLogin.mockReset();
  // Default: background refresh fails silently and the session is kept
  // optimistically (tests that care configure their own resolution).
  fetchMe.mockReset().mockRejectedValue(new Error('idle'));
  api.post.mockReset().mockResolvedValue({ ok: true });
});

describe('AuthProvider boot', () => {
  it('boots unauthenticated as ready with no capabilities', async () => {
    renderAuth();
    expect(screen.getByTestId('ready').textContent).toBe('true');
    expect(screen.getByTestId('user').textContent).toBe('none');
    expect(screen.getByTestId('can-settings').textContent).toBe('false');
    expect(fetchMe).not.toHaveBeenCalled();
  });

  it('restores a persisted session via fetchMe when a token exists', async () => {
    authStore.token = 'tok';
    fetchMe.mockResolvedValue({
      user: { id: 1, role: 'owner' },
      tenant: { status: 'ACTIVE' },
    });

    renderAuth();

    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('owner'));
    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(authStore.user.role).toBe('owner');
    expect(screen.getByTestId('can-settings').textContent).toBe('true');
    expect(screen.getByTestId('needs-activation').textContent).toBe('false');
  });

  it('clears the store when fetchMe rejects (expired token)', async () => {
    authStore.token = 'stale';
    fetchMe.mockRejectedValue(new Error('401'));

    renderAuth();

    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'));
    expect(screen.getByTestId('user').textContent).toBe('none');
    expect(authStore.token).toBe('');
  });

  it('still boots instantly from a persisted session but refreshes the tenant in the background', async () => {
    authStore.token = 'tok';
    authStore.user = { id: 2, role: 'manager' };
    authStore.tenant = { status: 'PENDING_ACTIVATION' };
    fetchMe.mockResolvedValue({
      user: { id: 2, role: 'manager' },
      tenant: { status: 'ACTIVE' },
    });

    renderAuth();

    // Optimistic: no flicker to logged-out while the refresh is in flight.
    expect(screen.getByTestId('user').textContent).toBe('manager');
    expect(fetchMe).toHaveBeenCalledTimes(1);
    // The stale pre-activation snapshot must be replaced so the license
    // gate cannot loop the user back to /activate-license.
    await waitFor(() => expect(screen.getByTestId('needs-activation').textContent).toBe('false'));
    expect(authStore.tenant.status).toBe('ACTIVE');
  });

  it('keeps the optimistic session when the background refresh fails', async () => {
    authStore.token = 'tok';
    authStore.user = { id: 7, role: 'owner' };
    authStore.tenant = { status: 'ACTIVE' };
    fetchMe.mockRejectedValue(new Error('offline'));

    renderAuth();

    expect(screen.getByTestId('user').textContent).toBe('owner');
    await waitFor(() => expect(fetchMe).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('user').textContent).toBe('owner');
    expect(authStore.token).toBe('tok');
  });
});

describe('login / logout / capability gate', () => {
  it('login stores the identity and gates capabilities by role', async () => {
    apiLogin.mockResolvedValue({
      user: { id: 3, role: 'cashier' },
      tenant: { status: 'ACTIVE' },
      requiresPasswordChange: true,
    });

    renderAuth();
    fireEvent.click(screen.getByText('in'));
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('cashier'));
    expect(apiLogin).toHaveBeenCalledWith('admin', 'pw');
    expect(screen.getByTestId('admin').textContent).toBe('false');
    expect(screen.getByTestId('can-sell').textContent).toBe('true');
    expect(screen.getByTestId('can-settings').textContent).toBe('false');
  });

  it('login resolves with the requiresPasswordChange flag', async () => {
    apiLogin.mockResolvedValue({
      user: { id: 4, role: 'manager' },
      tenant: { status: 'PENDING_ACTIVATION' },
      requiresPasswordChange: false,
    });

    renderAuth();
    const auth = screen.getByText('in');
    fireEvent.click(auth);
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('manager'));
    expect(screen.getByTestId('needs-activation').textContent).toBe('true');
    expect(screen.getByTestId('admin').textContent).toBe('true');
  });

  it('logout posts to the server and drops the session even if the call fails', async () => {
    authStore.set({ token: 'tok', user: { id: 5, role: 'owner' }, tenant: { status: 'ACTIVE' } });
    api.post.mockRejectedValue(new Error('network down'));

    renderAuth();
    expect(screen.getByTestId('user').textContent).toBe('owner');

    fireEvent.click(screen.getByText('out'));
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('none'));
    expect(api.post).toHaveBeenCalledWith('/auth/logout');
    expect(authStore.token).toBe('');
    expect(screen.getByTestId('can-settings').textContent).toBe('false');
  });

  it('app:unauthorized event clears credentials (single-shot 401 path)', async () => {
    authStore.set({ token: 'tok', user: { id: 6, role: 'owner' }, tenant: { status: 'ACTIVE' } });

    renderAuth();
    expect(screen.getByTestId('user').textContent).toBe('owner');

    window.dispatchEvent(new Event('app:unauthorized'));
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('none'));
    expect(authStore.token).toBe('');
  });
});
