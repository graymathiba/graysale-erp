// Single place where environment configuration is read and validated.
// Fail fast at boot on nonsense values instead of failing mid-request.

function intEnv(name, dflt, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}="${raw}": expected an integer between ${min} and ${max}.`);
  }
  return n;
}

export const config = {
  port: intEnv('PORT', 3030, { min: 1, max: 65535 }),
  sessionTtlMs: intEnv('SESSION_TTL_MS', 12 * 3600_000, { min: 60_000, max: 365 * 86400_000 }),
  dbPath: process.env.DB_PATH || null,
  nodeEnv: process.env.NODE_ENV || 'development',
  // Optional TLS: set both to serve HTTPS instead of cleartext HTTP.
  tlsCert: process.env.TLS_CERT || null,
  tlsKey: process.env.TLS_KEY || null,
  // DB backups (VACUUM INTO): default dir is <data folder>/backups.
  backupDir: process.env.BACKUP_DIR || null,
  backupKeep: intEnv('BACKUP_KEEP', 7, { min: 1, max: 365 }),
  backupIntervalHours: intEnv('BACKUP_INTERVAL_HOURS', 24, { min: 1, max: 24 * 30 }),
};

export default config;
