import { openDb, initDb } from './db/database.js';
import { AuthService } from './services/auth.js';
import { CatalogService } from './services/catalog.js';
import { CustomersService, SuppliersService } from './services/parties.js';
import { AccountingService } from './services/accounting.js';
import { InvoicingService } from './services/invoicing.js';
import { PosService } from './services/pos.js';
import { PaymentsService } from './services/payments.js';
import { PurchasingService } from './services/purchasing.js';
import { BanksService } from './services/banks.js';
import { EodService } from './services/eod.js';
import { ReportingService } from './services/reporting.js';
import { CompanySettingsService } from './services/companySettings.js';
import { TenantProfileService } from './services/tenantProfile.js';
import { EcoCashService } from './services/ecocash.js';
import { FiscalService } from './services/fiscal.js';
import { StorageService } from './storage/service.js';

export function createServices(db) {
  const auth = new AuthService(db);
  const catalog = new CatalogService(db, auth);
  const customers = new CustomersService(db);
  const suppliers = new SuppliersService(db);
  const accounting = new AccountingService(db);
  const invoicing = new InvoicingService(db, { accounting });
  const eco = new EcoCashService({ db });
  const fiscal = new FiscalService({ db });
  const pos = new PosService({ db, catalog, accounting, invoicing, auth, eco, fiscal });
  const payments = new PaymentsService({ db, accounting, invoicing });
  const purchasing = new PurchasingService({ db, catalog, invoicing, auth });
  const banks = new BanksService(db);
  const eod = new EodService(db);
  const reports = new ReportingService(db);
  const companySettings = new CompanySettingsService(db);
  const tenantProfile = new TenantProfileService(db, auth);
  return {
    db,
    auth,
    catalog,
    customers,
    suppliers,
    accounting,
    invoicing,
    pos,
    payments,
    purchasing,
    banks,
    eod,
    reports,
    companySettings,
    tenantProfile,
    eco,
    fiscal,
  };
}

// dbPath given ⇒ storage is explicitly managed (tests, direct open): the data
// lives exactly where the caller says and no descriptor ceremony is required.
// No dbPath ⇒ a StorageService resolves the folder + descriptor from the env.
export function createApp({ dbPath = null, storage = null, db = null } = {}) {
  if (storage && dbPath === null) dbPath = storage.dbPath;
  if (dbPath === null && storage === null && db === null) {
    // Legacy default — resolve through storage so a moved folder is caught
    // before its data is opened.
    storage = new StorageService();
    dbPath = storage.dbPath;
  }
  const handle = db || initDb(openDb(dbPath));
  db = handle;
  const services = createServices(db);
  if (storage) {
    services.storage = storage;
    storage.setDb(db);
    storage.attachedPath = dbPath;
  } else {
    services.storage = new StorageService({ dbPath, managed: true });
    services.storage.setDb(db);
    services.storage.attachedPath = dbPath;
  }
  services.auth.ensureDefaultData();
  return services;
}

export default { createApp, createServices };
