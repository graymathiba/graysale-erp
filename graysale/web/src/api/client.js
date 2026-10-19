// Thin fetch wrapper over the GraySale backend (/api/v1).
// Central HTTP policy lives here:
//   * every request carries `Authorization: Bearer <token>`
//   * a stale/expired session raises exactly ONE "session expired" notice,
//     clears stored credentials, and signals the auth context to redirect.

const tokenKey = 'gs_token';
const userKey = 'gs_user';
const tenantKey = 'gs_tenant';
const SESSION_EXPIRED_MSG = 'Session expired. Please log in again.';
const ACTIVATION_REQUIRED_MSG = 'Your GraySale license is not active. Activation required before continuing.';

export const authStore = {
  get token() {
    return localStorage.getItem(tokenKey) || '';
  },
  get user() {
    try {
      return JSON.parse(localStorage.getItem(userKey) || 'null');
    } catch {
      return null;
    }
  },
  get tenant() {
    try {
      return JSON.parse(localStorage.getItem(tenantKey) || 'null');
    } catch {
      return null;
    }
  },
  set(data) {
    localStorage.setItem(tokenKey, data.token);
    localStorage.setItem(userKey, JSON.stringify(data.user));
    if (data.tenant) localStorage.setItem(tenantKey, JSON.stringify(data.tenant));
    // A fresh valid session means past expiry notices must not replay.
    disarmAuthGuard();
    disarmActivationGuard();
  },
  clear() {
    localStorage.removeItem(tokenKey);
    localStorage.removeItem(userKey);
    localStorage.removeItem(tenantKey);
  },
};

export class ApiError extends Error {
  constructor(message, status, code, { silent = false } = {}) {
    super(message || 'Request failed');
    this.status = status;
    this.code = code;
    // `silent` marks errors already surfaced by the central interceptor
    // (session expiry) so callers skip their own redundant toasts.
    this.silent = silent;
  }
}

// ---------- single-instance 401 guard ----------
let authGuardArmed = false;

export function disarmAuthGuard() {
  authGuardArmed = false;
}

// ---------- single-instance 402 (license required) guard ----------
let activationGuardArmed = false;

export function disarmActivationGuard() {
  activationGuardArmed = false;
}

// Fires the activation-required notice ONCE per session. Does not clear the
// session (the user is authenticated, just not licensed yet).
function handleActivationRequired() {
  if (activationGuardArmed) return false;
  activationGuardArmed = true;
  raiseToast(ACTIVATION_REQUIRED_MSG, 'err');
  window.dispatchEvent(new CustomEvent('app:activation-required'));
  return true;
}

function raiseToast(msg, kind) {
  window.dispatchEvent(new CustomEvent('app:toast', { detail: { msg, kind } }));
}

// Fires the session-expiry notice ONCE, no matter how many concurrent
// background requests hit 401 at the same time. Returns true only for the
// request that triggered the notice.
function handleSessionExpired() {
  if (authGuardArmed) return false;
  authGuardArmed = true;
  authStore.clear();
  raiseToast(SESSION_EXPIRED_MSG, 'err');
  window.dispatchEvent(new CustomEvent('app:unauthorized'));
  return true;
}

async function request(method, path, body, { skipAuthGuard = false } = {}) {
  const opts = { method, headers: {} };
  const token = authStore.token;
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('/api/v1' + path, opts);
  } catch (e) {
    throw new ApiError('Network error — is the backend running?', 0, 'NETWORK');
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  const msg = data.error || data.message || `HTTP ${res.status}`;

  if (res.status === 401 && path !== '/auth/login' && !skipAuthGuard) {
    // Stale/expired session: central interceptor owns the message + redirect.
    handleSessionExpired();
    throw new ApiError(msg, 401, data.code, { silent: true });
  }
  if (res.status === 402 && !skipAuthGuard) {
    // License gate: tenant exists but is not activated yet.
    handleActivationRequired();
    throw new ApiError(msg, 402, data.code, { silent: true });
  }
  if (!res.ok) {
    throw new ApiError(msg, res.status, data.code);
  }
  return data;
}

export const api = {
  get: (p, opts) => request('GET', p, undefined, opts),
  post: (p, b, opts) => request('POST', p, b, opts),
  put: (p, b, opts) => request('PUT', p, b, opts),
  del: (p, opts) => request('DELETE', p, undefined, opts),
};

export async function login(username, password) {
  const r = await api.post('/auth/login', { username, password });
  if (!r.ok) throw new ApiError(r.error || 'Login failed', 401);
  authStore.set({ token: r.token, user: r.user, tenant: r.tenant });
  return { user: r.user, tenant: r.tenant, requiresPasswordChange: !!r.requiresPasswordChange };
}

// Boot-time session validation. Errors here are handled silently by AuthContext
// (no expiry toast on first paint — the user is simply sent to /login).
export async function fetchMe() {
  const data = await api.get('/auth/me', { skipAuthGuard: true });
  return data;
}

export function isHandledError(e) {
  return !!e && e.silent === true;
}
