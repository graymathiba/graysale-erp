// Company profile + banking details used to render dynamic
// invoices / quotations. banking_details is stored as JSON text.

import { resolveTenantId } from '../lib/tenant.js';

const DEFAULTS = {
  company_name: '',
  trading_as: '',
  tagline: '',
  address: '',
  telephone: '',
  mobile: '',
  reg_number: '',
  tin_number: '',
  vat_number: '',
  banking_details: [],
};

function parseBanks(text) {
  try {
    const arr = JSON.parse(text || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export class CompanySettingsService {
  constructor(db) {
    this.db = db;
  }

  get(tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const row = this.db.prepare('SELECT * FROM company_settings WHERE id = 1 AND tenant_id = ?').get(tenant);
    if (!row) return { ...DEFAULTS };
    return {
      company_name: row.company_name || '',
      trading_as: row.trading_as || '',
      tagline: row.tagline || '',
      address: row.address || '',
      telephone: row.telephone || '',
      mobile: row.mobile || '',
      reg_number: row.reg_number || '',
      tin_number: row.tin_number || '',
      vat_number: row.vat_number || '',
      banking_details: parseBanks(row.banking_details),
      updated_at: row.updated_at,
      tenant_id: row.tenant_id,
    };
  }

  update(payload = {}, tenantId) {
    const tenant = resolveTenantId(this.db, tenantId);
    const banks = Array.isArray(payload.banking_details) ? payload.banking_details : [];
    this.db
      .prepare(
        `
      INSERT INTO company_settings (
        id, company_name, trading_as, tagline, address, telephone, mobile,
        reg_number, tin_number, vat_number, banking_details, tenant_id, updated_at
      ) VALUES (
        1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime')
      )
      ON CONFLICT(id) DO UPDATE SET
        company_name = excluded.company_name,
        trading_as = excluded.trading_as,
        tagline = excluded.tagline,
        address = excluded.address,
        telephone = excluded.telephone,
        mobile = excluded.mobile,
        reg_number = excluded.reg_number,
        tin_number = excluded.tin_number,
        vat_number = excluded.vat_number,
        banking_details = excluded.banking_details,
        tenant_id = excluded.tenant_id,
        updated_at = datetime('now','localtime')
    `,
      )
      .run(
        payload.company_name || '',
        payload.trading_as || '',
        payload.tagline || '',
        payload.address || '',
        payload.telephone || '',
        payload.mobile || '',
        payload.reg_number || '',
        payload.tin_number || '',
        payload.vat_number || '',
        JSON.stringify(banks),
        tenant,
      );
    return this.get(tenant);
  }
}

export default CompanySettingsService;
