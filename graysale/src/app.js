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

export function createServices(db) {
  const auth = new AuthService(db);
  const catalog = new CatalogService(db, auth);
  const customers = new CustomersService(db);
  const suppliers = new SuppliersService(db);
  const accounting = new AccountingService(db);
  const invoicing = new InvoicingService(db);
  const pos = new PosService({ db, catalog, accounting, invoicing, auth });
  const payments = new PaymentsService({ db, accounting, invoicing });
  const purchasing = new PurchasingService({ db, catalog, invoicing, auth });
  const banks = new BanksService(db);
  const eod = new EodService(db);
  const reports = new ReportingService(db);
  const companySettings = new CompanySettingsService(db);
  const tenantProfile = new TenantProfileService(db, auth);
  return { db, auth, catalog, customers, suppliers, accounting, invoicing, pos, payments, purchasing, banks, eod, reports, companySettings, tenantProfile };
}

export function createApp({ dbPath } = {}) {
  const db = initDb(openDb(dbPath));
  const services = createServices(db);
  services.auth.ensureDefaultData();
  return services;
}

export default { createApp, createServices };