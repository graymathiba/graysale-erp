import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// The client keeps module-level guard state (401/402 single-fire) and reads
// localStorage lazily — re-import a fresh copy for every test.

function jsonRes(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

let client;
const winListeners = [];

function onWin(type, handler) {
  window.addEventListener(type, handler);
  winListeners.push([type, handler]);
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn());
  client = await import('./client');
});

afterEach(() => {
  winListeners.forEach(([type, handler]) => window.removeEventListener(type, handler));
  winListeners.length = 0;
  vi.unstubAllGlobals();
});

describe('api requests', () => {
  test('attaches the bearer token to every request', async () => {
    localStorage.setItem('gs_token', 'tok-123');
    fetch.mockResolvedValue(jsonRes(200, { ok: true }));

    await client.api.get('/settings');

    expect(fetch).toHaveBeenCalledWith('/api/v1/settings', {
      method: 'GET',
      headers: { Authorization: 'Bearer tok-123' },
    });
  });

  test('omits the Authorization header when logged out', async () => {
    fetch.mockResolvedValue(jsonRes(200, {}));

    await client.api.get('/auth/me');

    expect(fetch).toHaveBeenCalledWith('/api/v1/auth/me', { method: 'GET', headers: {} });
  });

  test('serialises JSON bodies with a Content-Type header', async () => {
    fetch.mockResolvedValue(jsonRes(200, {}));

    await client.api.post('/pos/sell', { items: [] });

    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe('/api/v1/pos/sell');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ items: [] });
  });

  test('throws ApiError carrying the server message on non-2xx', async () => {
    fetch.mockResolvedValue(jsonRes(500, { error: 'Boom' }));

    await expect(client.api.get('/reports')).rejects.toMatchObject({
      message: 'Boom',
      status: 500,
      silent: false,
    });
  });

  test('maps network failure to a friendly ApiError', async () => {
    fetch.mockRejectedValue(new TypeError('fetch failed'));

    await expect(client.api.get('/orders')).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK',
    });
  });
});

describe('401 session-expiry interceptor', () => {
  test('clears credentials and raises exactly one notice across concurrent 401s', async () => {
    localStorage.setItem('gs_token', 'stale');
    localStorage.setItem('gs_user', JSON.stringify({ id: 1, username: 'admin' }));
    const toasts = [];
    let unauthorized = 0;
    onWin('app:toast', (e) => toasts.push(e.detail));
    onWin('app:unauthorized', () => unauthorized++);
    fetch.mockResolvedValue(jsonRes(401, { error: 'UNAUTHORIZED', code: 'UNAUTHORIZED' }));

    await expect(client.api.get('/orders')).rejects.toMatchObject({ status: 401, silent: true });
    await expect(client.api.get('/orders')).rejects.toMatchObject({ status: 401, silent: true });

    expect(toasts).toEqual([{ msg: 'Session expired. Please log in again.', kind: 'err' }]);
    expect(unauthorized).toBe(1);
    expect(localStorage.getItem('gs_token')).toBe(null);
    expect(localStorage.getItem('gs_user')).toBe(null);
  });

  test('does not fire for the login endpoint itself', async () => {
    const toasts = [];
    onWin('app:toast', (e) => toasts.push(e.detail));
    fetch.mockResolvedValue(jsonRes(401, { error: 'Bad credentials' }));

    await expect(client.api.post('/auth/login', { username: 'x', password: 'y' })).rejects.toMatchObject({
      status: 401,
      silent: false,
    });

    expect(toasts).toHaveLength(0);
  });
});

describe('402 activation gate', () => {
  test('raises a single activation notice and keeps the session', async () => {
    localStorage.setItem('gs_token', 'tok');
    const toasts = [];
    let activations = 0;
    onWin('app:toast', (e) => toasts.push(e.detail));
    onWin('app:activation-required', () => activations++);
    fetch.mockResolvedValue(jsonRes(402, { error: 'NOT_ACTIVATED' }));

    await expect(client.api.get('/reports')).rejects.toMatchObject({ status: 402, silent: true });
    await expect(client.api.get('/reports')).rejects.toMatchObject({ status: 402, silent: true });

    expect(activations).toBe(1);
    expect(toasts).toEqual([
      { msg: 'Your GraySale license is not active. Activation required before continuing.', kind: 'err' },
    ]);
    expect(localStorage.getItem('gs_token')).toBe('tok');
  });
});
