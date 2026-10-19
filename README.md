# GraySale ERP

Local-first retail POS + accounting suite: Node.js (SQLite) backend, React (Vite) web front-end, Flutter POS client.

## Layout

```
graysale/          Node backend + React web app
  src/             server, domain services, HTTP routes, DB schema/migrations
  src/http/routes/ per-domain route modules (auth, catalog, pos, accounting, ...)
  test/            node:test suite (119 tests, incl. real-HTTP e2e)
  web/             Vite + React front-end (built to web/dist, served by the server)
pos_app/           Flutter POS client (talks to http://localhost:3030/api/v1)
```

## Requirements

- Node.js >= 22.5 (uses `node:sqlite`; `.nvmrc` pins 22). The server refuses
  older runtimes at boot and warns on Node > 22 (`node:sqlite` is experimental).
- Flutter 3.x (only for the mobile till)

## Quick start

```bash
cd graysale
npm install
npm start            # http://localhost:3030  (first run: /setup storage wizard)
```

The web front-end must be built once before the server can serve it:

```bash
npm run build:web    # writes graysale/web/dist
```

For front-end development use `npm --prefix web run dev` (Vite dev server).

## Tests & lint

```bash
npm test                    # backend node:test suite
npm run test:coverage       # same suite + coverage report
npm run lint                # ESLint (backend + web), 0 errors expected
npm run format              # Prettier write
npm run format:check        # Prettier verify (CI gate)
npm --prefix web run test   # front-end Vitest suite
```

## Configuration

All environment variables are optional — see `graysale/.env.example` for the
full annotated list (the app does not load `.env` files; export them via your
shell, systemd `EnvironmentFile=`, or process manager). Summary:

| Variable               | Default                | Purpose                                  |
| ---------------------- | ---------------------- | ---------------------------------------- |
| `PORT`                 | `3030`                 | HTTP port                                |
| `DB_PATH`              | `src/data/graysale.db` | SQLite database path                     |
| `SESSION_TTL_MS`       | 12h                    | Login session lifetime                   |
| `LOG_REQUESTS`         | on                     | Per-request log line; set `0` to disable |
| `NODE_ENV`             | —                      | `production` silences bootstrap banner   |
| `BACKUP_DIR`           | `<data>/backups`       | DB snapshot folder                       |
| `BACKUP_KEEP`          | `7`                    | Snapshots to keep (rotating)             |
| `BACKUP_INTERVAL_HOURS`| `24`                   | Automatic snapshot interval              |
| `TLS_CERT` / `TLS_KEY` | —                      | Serve HTTPS instead of cleartext HTTP    |

EcoCash sandbox credentials in tests come from `ECOCASH_SANDBOX_USERNAME` /
`ECOCASH_SANDBOX_PASSWORD` / `ECOCASH_SANDBOX_MERCHANT_CODE` (throwaway
defaults are baked in for local runs).

## Backups

Snapshots are taken with SQLite `VACUUM INTO` (consistent even while the app
is writing), one at boot and then every `BACKUP_INTERVAL_HOURS`, rotating to
the newest `BACKUP_KEEP` files. Admins can also run/list them on demand:

- `POST /api/v1/settings/backup` — create a snapshot now
- `GET  /api/v1/settings/backups` — list snapshots (newest first)

Copy the backup folder off-machine (NAS, portable drive) for real disaster
recovery — a backup next to the live DB only protects against corruption, not
theft/fire.

## Security

- **LAN HTTP**: the server binds `0.0.0.0` and speaks cleartext HTTP. On a
  trusted shop LAN this is normal, but bearer tokens are readable by anyone
  who can sniff the network. For untrusted networks set `TLS_CERT`/`TLS_KEY`
  (both required together) to serve HTTPS, and firewall the port so only
  tills can reach it.
- **Auth**: passwords hashed with `scrypt` + per-user salt, session tokens
  stored as SHA-256 hashes, login rate-limited (5 failures / 5 min), single
  active session per user.
- **Headers**: CSP, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy` on every response.
- **Licensing gate**: tenants must be activated (`402` otherwise); unactivated
  instances expose no domain data.
- Change the bootstrap `admin / admin123` password at first login.

## CI

`.github/workflows/ci.yml` runs on push/PR: `npm ci` → format check → lint →
backend audit → backend tests with coverage → web install → web audit → web
tests → web build. Both audit steps fail on any `high`+ advisory.
