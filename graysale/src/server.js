import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The whole data layer sits on node:sqlite, which is experimental and only
// exists from Node 22.5. Fail fast on older runtimes, warn on newer majors
// where the API may have drifted (CI pins Node 22).
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number);
if (NODE_MAJOR < 22 || (NODE_MAJOR === 22 && NODE_MINOR < 5)) {
  console.error(`GraySale requires Node.js >= 22.5.0 (node:sqlite). Detected ${process.version}.`);
  process.exit(1);
}
if (NODE_MAJOR > 22) {
  console.warn(
    `[warn] Node ${process.version}: GraySale is tested on Node 22 — node:sqlite is experimental and may differ on newer majors.`,
  );
}

const http = await import('node:http');
const https = await import('node:https');
const os = await import('node:os');
const { createApp } = await import('./app.js');
const { config } = await import('./config.js');
const { createHttpServer } = await import('./http/routes.js');
const { StorageService } = await import('./storage/service.js');
const { backupDatabase } = await import('./db/backup.js');

// Resolve where the data lives BEFORE opening the DB, so a moved storage
// folder is detected before a single SQLite handle touches it.
const storage = new StorageService();
let app = createApp({ storage });
let handler = createHttpServer(app);

// --- transport: optional TLS (TLS_CERT + TLS_KEY), cleartext HTTP otherwise ---
const useTls = !!(config.tlsCert || config.tlsKey);
if (config.tlsCert && !config.tlsKey) {
  console.error('TLS_KEY is required when TLS_CERT is set (and vice versa).');
  process.exit(1);
}
function readPem(path) {
  try {
    return readFileSync(path);
  } catch (e) {
    console.error(`Cannot read TLS key/cert at ${path}: ${e.message}`);
    process.exit(1);
  }
}
const transportOpts = useTls ? { cert: readPem(config.tlsCert), key: readPem(config.tlsKey) } : {};
const scheme = useTls ? 'https' : 'http';

const server = useTls
  ? https.createServer(transportOpts, (req, res) => handler(req, res))
  : http.createServer((req, res) => handler(req, res));
// Don't let a stalled peer hold a connection open indefinitely: headers must
// arrive within 15s and the full request within 60s.
server.headersTimeout = 15_000;
server.requestTimeout = 60_000;

// When a setup decision relocates the data folder the running SQLite handle
// must be swapped for the new file. Rebuild the app + handler behind the same
// server instance — in-flight requests finish, the next one hits the new DB.
storage.onRelocate(() => {
  try {
    app.db.close();
  } catch {
    /* already closed */
  }
  // createApp re-opens exactly what the descriptor says — no extra bookkeeping needed.
  app = createApp({ storage });
  handler = createHttpServer(app);
  console.log(`[storage] data folder relocated → served from ${app.storage.dbPath}`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`ERROR: port ${config.port} is already in use. Use PORT=XXXX npm start`);
    process.exit(1);
  }
  throw e;
});

// --- backups: one snapshot at boot + on an interval, rotating (BACKUP_KEEP) ---
function backupDir() {
  return config.backupDir || join(dirname(app.storage.attachedPath || app.storage.dbPath), 'backups');
}
function runBackup(trigger) {
  try {
    const r = backupDatabase(app.db, { dir: backupDir(), keep: config.backupKeep });
    console.log(`[backup:${trigger}] ${r.file} (${r.bytes} bytes)`);
  } catch (e) {
    console.error(`[backup:${trigger}] failed: ${e.message}`);
  }
}
runBackup('boot');
const backupTimer = setInterval(() => runBackup('interval'), config.backupIntervalHours * 3600_000);
backupTimer.unref();

server.listen(config.port, '0.0.0.0', () => {
  const phase = app.storage.phase;
  console.log(`GraySale running at ${scheme}://localhost:${config.port}  (storage: ${phase})`);
  if (phase !== 'ready') {
    console.log(`  ➜ Storage not ready for this machine. Visit /setup to configure it.`);
  }
  if (phase === 'ready') {
    // Only surface the bootstrap credentials while the forced-change flag is
    // still set — once rotated, the default password never appears in logs.
    const pending = (() => {
      try {
        return app.db
          .prepare(
            "SELECT username FROM users WHERE role = 'owner' AND requires_password_change = 1 ORDER BY id LIMIT 1",
          )
          .get();
      } catch {
        return null;
      }
    })();
    if (pending) {
      console.log(`First-run bootstrap: ${pending.username} / admin123  (change it at first login!)`);
    }
  }
  console.log(`  Data: ${app.storage.dbPath}`);
  const ifaces = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i.family === 'IPv4' && !i.internal);
  for (const i of ifaces) console.log(`  LAN: ${scheme}://${i.address}:${config.port}`);
});
