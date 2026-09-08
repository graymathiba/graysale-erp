// Tenant licensing gate. Applied to every GraySale ERP tenant-facing request
// (i.e. anything NOT under the super-admin Control Tower scope and NOT under
// the /license/ scope used by the first-time activation flow).
//
//   * status === 'BLOCKED'              -> 403 { error: 'ACCOUNT_SUSPENDED' }
//   * status === 'PENDING_KEY' /
//     status === 'PENDING_ACTIVATION'   -> 402 { error: 'ACTIVATION_REQUIRED' }
//   * license_expires_at < now          -> 402 { error: 'LICENSE_EXPIRED' }
//
// Super-admin + license routes bypass this gate entirely — the software owner
// operates outside normal tenant boundaries, and an unactivated instance must
// still be able to activate itself.

import { LicensingService } from './index.js';

// Returns true when the request must be short-circuited (response already sent).
export function makeEnforceTenantStatus(db) {
  const licensing = new LicensingService(db);

  return function enforceTenantStatus(req, res, parts) {
    const superAdminScope =
      (parts[0] === 'superadmin') ||
      (parts[0] === 'license') ||
      (parts[0] === 'auth' && (parts[1] === 'login' || parts[1] === 'logout' || parts[1] === 'me'));

    if (superAdminScope) return false;

    const tenant = licensing.currentTenant();
    if (!tenant) return false;

    if (tenant.status === 'BLOCKED') {
      send(res, 403, {
        error: 'ACCOUNT_SUSPENDED',
        message: 'Your GraySale ERP instance has been suspended. Please contact support.',
      });
      return true;
    }

    // First-time activation gate: an unactivated store cannot see products,
    // sales or any ERP data until a valid product key is redeemed.
    if (tenant.status === 'PENDING_KEY' || tenant.status === 'PENDING_ACTIVATION') {
      send(res, 402, {
        error: 'ACTIVATION_REQUIRED',
        message: 'Activation required. Redeem your product key to unlock GraySale ERP.',
      });
      return true;
    }

    if (tenant.isExpired) {
      send(res, 402, {
        error: 'LICENSE_EXPIRED',
        message: 'Your GraySale ERP license has expired. Please renew to continue.',
      });
      return true;
    }

    return false;
  };
}

function send(res, status, body) {
  if (res.headersSent) return { _sent: false };
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
  return { _sent: true };
}
