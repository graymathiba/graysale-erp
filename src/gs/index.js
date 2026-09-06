// Retail (graysale) services wired for the merged ERP server.
// Builds all ported services on the shared, already-migrated database and
// exposes them behind a route table that runs only for routes the main ERP
// handler does not own. Authentication is delegated to the main AuthService.

import { CatalogService } from './catalog.js';
import { CustomersService, SuppliersService } from './parties.js';
import { AccountingService } from './accounting.js';
import { InvoicingService } from './invoicing.js';
import { PosService } from './pos.js';
import { PaymentsService } from './payments.js';
import { PurchasingService } from './purchasing.js';
import { BanksService } from './banks.js';
import { EodService } from './eod.js';
import { ReportingService } from './reporting.js';
import { buildRoutes, matchGsRoute } from './routes.js';
import { AppError } from './errors.js';
import { hashPassword } from '../auth.js';

// graysale roles -> main ERP roles. Keep main role stored so rank-based caps work.
const ROLE_TO_MAIN = { owner: 'admin', accountant: 'manager' };
const MAIN_ROLES = new Set(['cashier', 'manager', 'admin']);

function makeGsAuth(mainAuth) {
  const gs = {
    // Main AuthService already resolves to the full users row.
    userForToken(token) {
      const u = mainAuth.userForToken(token);
      return u ? publicUser(u) : null;
    },
    createUser({ username, password, fullName, role, locationId }) {
      if (!username || password == null) throw new AppError('USERNAME_AND_PASSWORD_REQUIRED', 400);
      const mainRole = ROLE_TO_MAIN[role] || role;
      if (!MAIN_ROLES.has(mainRole)) throw new AppError(`INVALID_ROLE: ${role}`, 400);
      const existing = mainAuth.store.db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existing) throw new AppError(`DUPLICATE_USERNAME: ${username}`, 409);
      const info = mainAuth.store.db.prepare(
        'INSERT INTO users (username, password_hash, full_name, role, location_id) VALUES (?, ?, ?, ?, ?)'
      ).run(username, hashPassword(password), fullName || username, mainRole, locationId ?? null);
      return info.lastInsertRowid;
    },
    updateUser(id, fields) {
      const sets = [];
      const vals = [];
      if (fields.role != null) {
        const mainRole = ROLE_TO_MAIN[fields.role] || fields.role;
        if (!MAIN_ROLES.has(mainRole)) throw new AppError(`INVALID_ROLE: ${fields.role}`, 400);
        sets.push('role = ?'); vals.push(mainRole);
      }
      if (fields.fullName != null) { sets.push('full_name = ?'); vals.push(fields.fullName); }
      if (fields.active != null) { sets.push('active = ?'); vals.push(fields.active ? 1 : 0); }
      if (fields.locationId !== undefined) { sets.push('location_id = ?'); vals.push(fields.locationId); }
      if (fields.password != null) { sets.push('password_hash = ?'); vals.push(hashPassword(fields.password)); }
      if (!sets.length) return;
      vals.push(Number(id));
      mainAuth.store.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    },
    listUsers() {
      return mainAuth.listUsers();
    },
    require(user, capability) {
      if (!user) throw new AppError('Unauthorized', 401);
      if (!mainAuth.requireCapability(user, capability)) throw new AppError('Forbidden', 403);
      return user;
    },
    hasPermission(user, capability) {
      return !!user && mainAuth.requireCapability(user, capability);
    },
    audit(userId, username, action, entityType, entityId, detail) {
      mainAuth.audit(userId, username, action, entityType, entityId, detail);
    },
    listAudit(limit = 100) {
      return mainAuth.listAudit(limit);
    },
  };
  return gs;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    fullName: u.full_name ?? u.fullName,
    role: u.role,
    locationId: u.location_id ?? null,
    active: u.active,
  };
}

// Same body reader semantics as the main server, but parse failures become
// an AppError so the gs error mapper can produce a 400.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new AppError('BAD_JSON', 400)); }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  if (res.headersSent) return true;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(typeof body === 'object' ? body : { ok: body }));
  return true;
}

function statusFor(e) {
  if (e && Number.isInteger(e.status)) return e.status;
  const msg = String(e?.message || '');
  if (msg.includes('JSON')) return 400;
  if (e?.code === 'ERR_SQLITE_ERROR') {
    if (msg.includes('UNIQUE')) return 409;
    return 400;
  }
  return 500;
}

export function createGsRouter(store, mainAuth) {
  const db = store.db;
  const auth = makeGsAuth(mainAuth);
  const catalog = new CatalogService(db);
  const customers = new CustomersService(db);
  const suppliers = new SuppliersService(db);
  const accounting = new AccountingService(db);
  const invoicing = new InvoicingService(db);
  const payments = new PaymentsService({ db, accounting, invoicing });
  const banks = new BanksService(db);
  const eod = new EodService(db);
  const reports = new ReportingService(db);
  const pos = new PosService({ db, catalog, accounting, invoicing, auth });
  const purchasing = new PurchasingService({ db, catalog, invoicing, auth });

  const services = {
    db, auth, catalog, customers, suppliers, accounting, invoicing,
    pos, payments, purchasing, banks, eod, reports,
  };
  const routes = buildRoutes(services);

  return {
    services,
    catalog,
    customers,
    reports,
    matchGsRoute,

    // Returns true when the gs router handled the request (even on error).
    async handle(req, res, url, segments, mainUser) {
      const method = req.method;
      const match = matchGsRoute(routes, method, segments);
      if (!match) return false;

      const user = publicUser(mainUser) || {
        id: null, username: null, fullName: null, role: null, locationId: null, active: null,
      };
      const ctx = {
        services,
        req, res, url,
        token: (req.headers.authorization || '').replace(/^Bearer\s+/i, ''),
        user,
        query: Object.fromEntries(url.searchParams),
        params: match.params || {},
        json: (body, status = 200) => json(res, status, body),
        body: () => readBody(req),
      };

      try {
        if (match.caps) auth.require(user, match.caps);
        await match.handler(ctx);
        return true;
      } catch (e) {
        if (!res.headersSent) json(res, statusFor(e), { error: e?.message || 'INTERNAL' });
        return true;
      }
    },
  };
}

export { AppError };