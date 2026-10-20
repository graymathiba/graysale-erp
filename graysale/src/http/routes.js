import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forbidden } from '../lib/errors.js';
import { formatCents } from '../lib/money.js';
import { LicensingService, makeEnforceTenantStatus } from '../licensing/index.js';
import { NumID, dbSetting, setDefaultPrinter, backupDir } from './routeHelpers.js';
import { registerLicensing } from './routes/licensing.js';
import { registerSetup } from './routes/setup.js';
import { registerAuth } from './routes/auth.js';
import { registerUsers } from './routes/users.js';
import { registerCatalog } from './routes/catalog.js';
import { registerParties } from './routes/parties.js';
import { registerPos } from './routes/pos.js';
import { registerInvoicing } from './routes/invoicing.js';
import { registerPurchasing } from './routes/purchasing.js';
import { registerAccounting } from './routes/accounting.js';
import { registerEod } from './routes/eod.js';
import { registerReports } from './routes/reports.js';
import { registerSettings } from './routes/settings.js';

// Sentinel for endpoints that must work without a signed-in session: first-run
// storage setup, auth (login/register/set-password), licensing/activation and
// the provider webhook. Any other endpoint requires a signed-in user (when
// caps === null) or a user holding the listed capability.
const PUBLIC = Symbol('PUBLIC');

// React (Vite) frontend — the only UI. Built output lives in web/dist and is
// served for every non-API path (SPA fallback → index.html).
const WEB_DIST_DIR = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

// ---------- request context ----------
function makeCtx(services, req, res, url) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = services.auth.userForToken(token);
  return {
    services,
    req,
    res,
    url,
    user,
    token,
    tenantId: (user && user.tenantId) || null,
    json(body, status = 200) {
      const pretty = typeof body === 'object' ? body : { ok: body };
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(pretty));
      return true;
    },
    async body() {
      let data = '';
      for await (const c of req) {
        data += c;
        if (data.length > 8e6) break;
      }
      return data ? JSON.parse(data) : {};
    },
  };
}

function attachHelpers(services) {
  services.formatCents = formatCents;
  services.nicer = (n) => Number(n) || 0;
  return services;
}

// ---------- route table ----------
// Route definitions live in ./routes/*.js - one file per domain. This
// function only wires them together.
//
// Registration ORDER matters: matchRoute returns the FIRST match, so
// concrete paths (/products/low) must be registered before parameterised
// ones (/products/:id). Keep the calls below in the original section order.
//
// Routes with `PUBLIC` caps are reachable without any session (login,
// register-tenant, first-run setup, licensing redemption and the provider
// webhook). Every OTHER route requires a signed-in user: null caps means
// "any signed-in user", a capability list means "signed-in AND cap". This
// closes the anonymous-read hole on catalog / customers / reports /
// settings / orders that the legacy `null == open` convention left open.
export function buildHandler(services) {
  attachHelpers(services);
  const S = services;

  const R = [];
  const route = (method, path, caps, fn) => R.push({ method, path, caps, fn });

  const requireCap = (cap) => (ctx) => S.auth.require(ctx.user, cap);

  // Tenant owners may run the self-service profile endpoints; everyone else
  // (no session, cashier, manager...) is refused here and by the service layer.
  const ownerOnly = (ctx) => {
    if (!ctx.user || ctx.user.role !== 'owner') throw forbidden();
    return ctx.user;
  };

  const licensing = new LicensingService(S.db);
  const superAdmin = (ctx) => S.auth.requireSuperAdmin(ctx.user);

  const h = {
    services: S,
    route,
    PUBLIC,
    licensing,
    requireCap,
    ownerOnly,
    superAdmin,
    // registerLicensing audits Control Tower writes through the auth service.
    auth: S.auth,
    NumID,
    dbSetting,
    setDefaultPrinter,
    backupDir,
  };

  registerLicensing(h);
  registerSetup(h);
  registerAuth(h);
  registerUsers(h);
  registerCatalog(h);
  registerParties(h);
  registerPos(h);
  registerInvoicing(h);
  registerPurchasing(h);
  registerAccounting(h);
  registerEod(h);
  registerReports(h);
  registerSettings(h);

  return R;
}

// ---------- match a request ----------
export function matchRoute(routes, method, segments) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const parts = r.path.split('/').filter(Boolean);
    if (parts.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = segments[i];
      else if (parts[i] !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.fn, caps: r.caps, params };
  }
  return null;
}

// ---------- HTTP server ----------
// Response headers applied to EVERY response (JSON and static alike).
// The SPA loads Google Fonts and injects component styles at runtime, which
// is why style-src keeps 'unsafe-inline' + the fonts origins; scripts stay
// strictly same-origin. frame-ancestors 'none' closes clickjacking.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

// One line per completed request: METHOD path status elapsed-ms.
// Opt out with LOG_REQUESTS=0 (test/helpers.js sets this) — read per request
// so the flag is honoured no matter which module loads first.
const requestLogEnabled = () => process.env.LOG_REQUESTS !== '0';

const APP_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

export function createHttpServer(services) {
  const routes = buildHandler(services);
  const enforceTenantStatus = makeEnforceTenantStatus(services.db);
  return async (req, res) => {
    // Real ServerResponse has setHeader; the minimal response stubs used by
    // the HTTP tests do not, so feature-detect before stamping headers.
    if (typeof res.setHeader === 'function') {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    }
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const segments = url.pathname.split('/').filter(Boolean);
    const ctx = makeCtx(services, req, res, url);
    ctx.query = Object.fromEntries(url.searchParams);
    try {
      if (segments[0] === 'api' && segments[1] === 'v1') {
        const rest = segments.slice(2);
        // Liveness probe — answered before the storage and licensing gates so
        // a fresh install (and the Windows launcher waiting on boot) can tell
        // "process is up" from "needs setup/activation". No domain data.
        if (rest[0] === 'health' && rest.length === 1 && req.method === 'GET') {
          return ctx.json({
            ok: true,
            version: APP_VERSION,
            phase: (services.storage && services.storage.phase) || 'ready',
            time: new Date().toISOString(),
          });
        }
        // Storage gate: until the data folder is configured on this machine
        // (first run, or a moved USB folder acknowledged), only setup/login /
        // license + Static tower-scope endpoints are reachable. Everything else
        // answers 503 STORAGE_NOT_CONFIGURED so nothing opens foreign data.
        const storage = services.storage;
        if (storage && !storage.ready) {
          const isSetupScope = rest[0] === 'setup';
          const isAuthScope = rest[0] === 'auth';
          const isLicenseScope = rest[0] === 'license' || rest[0] === 'keys';
          const isSuperAdminScope = rest[0] === 'superadmin';
          if (!isSetupScope && !isAuthScope && !isLicenseScope && !isSuperAdminScope) {
            return ctx.json(
              {
                error: 'STORAGE_NOT_CONFIGURED',
                message: 'GraySale storage is not configured for this machine. Complete the setup screen first.',
                code: 'STORAGE_NOT_CONFIGURED',
                status: 503,
              },
              503,
            );
          }
        }
        // Licensing gate: superadmin + the whole /license scope + the storage
        // setup scope are never blocked so a fresh/moved instance can always
        // configure its data home and reactivate itself.
        const isSetupScope = rest[0] === 'setup';
        const isSuperAdminScope = rest[0] === 'superadmin';
        const isLicenseScope = rest[0] === 'license';
        if (!isSetupScope && !isSuperAdminScope && !isLicenseScope) {
          if (enforceTenantStatus(req, res, rest)) return;
        }
        const match = matchRoute(routes, req.method, rest);
        if (!match) return ctx.json({ error: 'NOT_FOUND' }, 404);
        // Auth gate — no route is "anonymous by default" anymore:
        //   PUBLIC  caps → truly open (no session needed)
        //   null    caps → signed-in user required (401 if anonymous)
        //   string  caps → signed-in user holding the capability (401/403)
        if (match.caps !== PUBLIC) {
          if (!ctx.user)
            return ctx.json({ error: 'UNAUTHORIZED', message: 'UNAUTHORIZED', code: 'UNAUTHORIZED', status: 401 }, 401);
          if (match.caps) services.auth.require(ctx.user, match.caps);
        }
        if (match.params) ctx.params = match.params;
        return await match.handler(ctx);
      }
      return serveStatic(req, res, url);
    } catch (e) {
      if (typeof e === 'object' && e && e.status) {
        // Clear, structured auth/error payloads: 401 / 403 carry a human
        // message plus a stable code the frontend can branch on.
        const body = { error: e.message, message: e.message, code: e.code || 'ERROR', status: e.status };
        return ctx.json(body, e.status);
      }
      if (e && e.message && e.message.includes('JSON')) return ctx.json({ error: 'BAD_JSON' }, 400);
      if (e && e.code === 'ERR_SQLITE_ERROR') {
        const msg = String(e.message || '');
        if (msg.includes('UNIQUE')) return ctx.json({ error: 'DUPLICATE: ' + msg }, 409);
        if (msg.includes('FOREIGN')) return ctx.json({ error: 'REFERENCE_ERROR: ' + msg }, 400);
        return ctx.json({ error: 'DB_ERROR: ' + msg }, 400);
      }
      console.error(e);
      return ctx.json({ error: e.message || 'INTERNAL' }, 500);
    } finally {
      if (requestLogEnabled() && segments[0] === 'api') {
        console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  };
}

async function serveStatic(req, res, url) {
  // Reject any path that tries to climb out of the static root
  // (.. / %2e%2e / encoded slashes): serve only what resolves inside
  // WEB_DIST_DIR. Closes directory-traversal reads of arbitrary files.
  const rawPath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1).replace(/^\//, '');
  if (!rawPath || rawPath.includes('\0')) return send404(res);
  const normalized = normalize(rawPath);
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized.includes('\\..')) {
    return send404(res);
  }
  let abs = join(WEB_DIST_DIR, normalized);
  // SPA fallback: unknown paths answer index.html so client-side routing works.
  if (!existsSync(abs)) abs = join(WEB_DIST_DIR, 'index.html');
  if (!existsSync(abs)) return send404(res);
  // Final belt-and-braces: the file actually served must live under the
  // static root — never elsewhere on disk (e.g. a symlinked escape).
  const realWeb = realSyncSafe(WEB_DIST_DIR);
  const realAbs = realSyncSafe(abs);
  const ok = realAbs === realWeb || realAbs.startsWith(realWeb.endsWith(sep) ? realWeb : realWeb + sep);
  if (!ok) return send404(res);
  try {
    const data = readFileSync(abs);
    const ext = extname(abs);
    res.writeHead(200, { 'Content-Type': (MIME[ext] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(data);
  } catch {
    send404(res);
  }
}

function realSyncSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function send404(res) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'NOT_FOUND' }));
}
