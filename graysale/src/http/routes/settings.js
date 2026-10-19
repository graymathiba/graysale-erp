// Instance settings (company + EcoCash/FDMS integration), dynamic
// company document settings, tenant self-service profile and printers.

import { backupDatabase, listBackups } from '../../db/backup.js';
import { config } from '../../config.js';

export function registerSettings({
  route,
  services: S,
  requireCap,
  ownerOnly,
  dbSetting,
  setDefaultPrinter,
  backupDir,
}) {
  const { auth } = S;

  route('GET', '/settings', null, (ctx) =>
    ctx.json({
      company: dbSetting(S, 'company.name'),
      address: dbSetting(S, 'company.address'),
      phone: dbSetting(S, 'company.phone'),
      tin: dbSetting(S, 'company.tin'),
      currency: dbSetting(S, 'company.currency'),
      taxName: dbSetting(S, 'tax.name'),
      termsDays: dbSetting(S, 'doc.default_terms_days'),
      fiscal: dbSetting(S, 'pos.fiscal') === '1',
      cashDrawer: dbSetting(S, 'pos.cash_drawer') === '1',
      ecocash: {
        enabled: dbSetting(S, 'ecocash.enabled') === '1',
        mode: dbSetting(S, 'ecocash.mode'),
        merchantCode: dbSetting(S, 'ecocash.merchant_code'),
        apiKeySet: !!dbSetting(S, 'ecocash.api_key'),
        baseUrl: dbSetting(S, 'ecocash.base_url'),
        publicKeySet: !!dbSetting(S, 'ecocash.public_key'),
        currency: dbSetting(S, 'ecocash.currency'),
        username: dbSetting(S, 'ecocash.username'),
        passwordSet: !!dbSetting(S, 'ecocash.password'),
        merchantPinSet: !!dbSetting(S, 'ecocash.merchant_pin'),
        merchantNumber: dbSetting(S, 'ecocash.merchant_number'),
        notifyUrl: dbSetting(S, 'ecocash.notify_url'),
      },
      fdms: {
        enabled: dbSetting(S, 'fdms.enabled') === '1',
        mode: dbSetting(S, 'fdms.mode'),
        baseUrl: dbSetting(S, 'fdms.base_url'),
        deviceId: dbSetting(S, 'fdms.device_id'),
        serialNo: dbSetting(S, 'fdms.serial_no'),
        activationKey: dbSetting(S, 'fdms.activation_key'),
        modelName: dbSetting(S, 'fdms.model_name'),
        modelVersion: dbSetting(S, 'fdms.model_version'),
        tin: dbSetting(S, 'fdms.tin'),
        currency: dbSetting(S, 'fdms.currency'),
        workstation: dbSetting(S, 'fdms.workstation'),
      },
    }),
  );
  route('POST', '/settings', 'settings.manage', async (ctx) => {
    requireCap('settings.manage')(ctx);
    const b = await ctx.body();
    const map = {
      company: 'company.name',
      address: 'company.address',
      phone: 'company.phone',
      tin: 'company.tin',
      currency: 'company.currency',
      taxName: 'tax.name',
      termsDays: 'doc.default_terms_days',
    };
    const ecoMap = {
      ecocashEnabled: 'ecocash.enabled',
      ecocashMode: 'ecocash.mode',
      ecocashMerchantCode: 'ecocash.merchant_code',
      ecocashApiKey: 'ecocash.api_key',
      ecocashBaseUrl: 'ecocash.base_url',
      ecocashPublicKey: 'ecocash.public_key',
      ecocashCurrency: 'ecocash.currency',
      ecocashUsername: 'ecocash.username',
      ecocashPassword: 'ecocash.password',
      ecocashMerchantPin: 'ecocash.merchant_pin',
      ecocashMerchantNumber: 'ecocash.merchant_number',
      ecocashNotifyUrl: 'ecocash.notify_url',
    };
    const fdmsMap = {
      fdmsEnabled: 'fdms.enabled',
      fdmsMode: 'fdms.mode',
      fdmsBaseUrl: 'fdms.base_url',
      fdmsDeviceId: 'fdms.device_id',
      fdmsSerialNo: 'fdms.serial_no',
      fdmsActivationKey: 'fdms.activation_key',
      fdmsModelName: 'fdms.model_name',
      fdmsModelVersion: 'fdms.model_version',
      fdmsTin: 'fdms.tin',
      fdmsCurrency: 'fdms.currency',
      fdmsWorkstation: 'fdms.workstation',
    };
    const upsert = S.db.prepare(`
      INSERT INTO settings (key, value, tenant_id) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    for (const [k, key] of Object.entries(map)) if (b[k] !== undefined) upsert.run(key, String(b[k]), ctx.tenantId);
    if (b.fiscal !== undefined) upsert.run('pos.fiscal', b.fiscal ? '1' : '0', ctx.tenantId);
    if (b.cashDrawer !== undefined) upsert.run('pos.cash_drawer', b.cashDrawer ? '1' : '0', ctx.tenantId);
    for (const [k, key] of Object.entries(ecoMap))
      if (b[k] !== undefined)
        upsert.run(key, typeof b[k] === 'boolean' ? (b[k] ? '1' : '0') : String(b[k]), ctx.tenantId);
    for (const [k, key] of Object.entries(fdmsMap))
      if (b[k] !== undefined)
        upsert.run(key, typeof b[k] === 'boolean' ? (b[k] ? '1' : '0') : String(b[k]), ctx.tenantId);
    auth.audit(ctx.user.id, ctx.user.username, 'SETTINGS_UPDATE', null, null, JSON.stringify(b));
    return ctx.json({ ok: true });
  });

  // ----- company settings (dynamic invoice/quotation documents) -----
  route('GET', '/company-settings', null, (ctx) => ctx.json(S.companySettings.get(ctx.tenantId)));
  route('PUT', '/company-settings', 'settings.manage', async (ctx) => {
    requireCap('settings.manage')(ctx);
    const b = await ctx.body();
    const saved = S.companySettings.update(b, ctx.tenantId);
    auth.audit(ctx.user.id, ctx.user.username, 'SETTINGS_UPDATE', 'company_settings', 1, JSON.stringify(b));
    return ctx.json(saved);
  });

  // ----- tenant profile (owner self-service) -----
  route('GET', '/tenant/profile', null, async (ctx) => {
    ownerOnly(ctx);
    return ctx.json(S.tenantProfile.get(ctx.tenantId));
  });
  route('PUT', '/tenant/profile', null, async (ctx) => {
    ownerOnly(ctx);
    const b = await ctx.body();
    const saved = S.tenantProfile.update(b, ctx.tenantId, ctx.user);
    return ctx.json(saved);
  });

  // ----- printers -----
  route('GET', '/printers', null, (ctx) =>
    ctx.json(S.db.prepare('SELECT * FROM printers ORDER BY is_default DESC, name').all()),
  );
  route('POST', '/printers', 'settings.manage', async (ctx) => {
    requireCap('settings.manage')(ctx);
    const b = await ctx.body();
    if (!b.name) return ctx.json({ error: 'PRINTER_NAME_REQUIRED' }, 400);
    const info = S.db
      .prepare(
        `
      INSERT INTO printers (name, type, connection, ip_address, cash_drawer, fiscal)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        b.name,
        b.type || '80mm',
        b.connection || 'USB',
        b.ipAddress || null,
        b.cashDrawer ? 1 : 0,
        b.fiscal ? 1 : 0,
      );
    if (b.isDefault) setDefaultPrinter(S, info.lastInsertRowid);
    auth.audit(ctx.user.id, ctx.user.username, 'PRINTER_CREATE', 'printer', info.lastInsertRowid, b.name);
    return ctx.json({ id: info.lastInsertRowid }, 201);
  });
  route('PUT', '/printers/:id', 'settings.manage', async (ctx) => {
    requireCap('settings.manage')(ctx);
    const b = await ctx.body();
    const sets = [];
    const vals = [];
    const map = {
      name: 'name',
      type: 'type',
      connection: 'connection',
      ipAddress: 'ip_address',
      cashDrawer: 'cash_drawer',
      fiscal: 'fiscal',
      active: 'active',
    };
    for (const [key, col] of Object.entries(map))
      if (b[key] !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(col === 'cash_drawer' || col === 'fiscal' || col === 'active' ? (b[key] ? 1 : 0) : b[key]);
      }
    if (!sets.length) return ctx.json({ ok: true });
    if (b.isDefault) {
      setDefaultPrinter(S, ctx.params.id);
    }
    vals.push(Number(ctx.params.id));
    S.db.prepare(`UPDATE printers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    auth.audit(ctx.user.id, ctx.user.username, 'PRINTER_UPDATE', 'printer', Number(ctx.params.id), JSON.stringify(b));
    return ctx.json({ ok: true });
  });
  route('DELETE', '/printers/:id', 'settings.manage', async (ctx) => {
    requireCap('settings.manage')(ctx);
    S.db.prepare('DELETE FROM printers WHERE id = ?').run(Number(ctx.params.id));
    return ctx.json({ ok: true });
  });

  // ----- database backups (VACUUM INTO snapshot, rotating) -----
  route('POST', '/settings/backup', 'settings.manage', (ctx) => {
    requireCap('settings.manage')(ctx);
    try {
      const r = backupDatabase(S.db, { dir: backupDir(S), keep: config.backupKeep });
      auth.audit(ctx.user.id, ctx.user.username, 'DB_BACKUP', null, null, r.file);
      return ctx.json({ ok: true, file: r.file.split(/[\\/]/).pop(), bytes: r.bytes });
    } catch (e) {
      return ctx.json({ ok: false, error: String(e.message || e) }, 500);
    }
  });
  route('GET', '/settings/backups', 'settings.manage', (ctx) => {
    requireCap('settings.manage')(ctx);
    return ctx.json(listBackups(backupDir(S)));
  });
}
