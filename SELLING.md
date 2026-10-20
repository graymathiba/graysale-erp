# Selling GraySale (reseller runbook)

Internal document — not shipped in the customer zip.

## What you hand a customer

Three build artifacts come out of `npm run package:win` in `graysale/`:

| Zip                                | For                          | What it is                                                                                                                      |
| ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GraySale-<v>-desktop-win-x64.zip` | **shops (default)**          | Flutter desktop app: double-click `graysale_desktop.exe`, it starts its own bundled server and opens the till inside the window |
| `GraySale-<v>-win-x64.zip`         | shops (no-WebView2 fallback) | Portable bundle: `GraySale.bat` starts the server, browser opens                                                                |
| `KeyMaster-<v>-win-x64.zip`        | **you (vendor)**             | KeyMaster: generate/manage product keys, see which shops are connected                                                          |

All three are self-contained — no installers, no internet needed on site
(bundled Node.js runtime; LAN tills just need Chrome/Edge and the host PC's
address).

Build everything fresh for a release:

```bash
cd graysale
npm test && npm run lint && npm --prefix web run test
npm run build:web
npm run package:win
# Flutter builds (only needed when the apps changed):
cd ../graysale_desktop && flutter build windows --release
cd ../keymaster && flutter build windows --release
cd ../graysale && node scripts/package-win.mjs
```

## Onboarding a customer (about 20 minutes)

Requirements: one Windows 10/11 PC (the "server"), shop LAN, optional 80mm
thermal printer (ESC/POS over USB — Chrome/Edge only).

1. Unpack the desktop zip to a permanent folder, e.g. `C:\GraySale`.
2. Double-click `graysale_desktop.exe` — the setup wizard opens inside the
   app (needs the WebView2 runtime; Windows 11 ships it. Without it the app
   offers "Open in browser" — same wizard, or fall back to the `.bat` zip).
3. In the wizard: keep the default data folder, create the company + owner
   login. (Bootstrap `admin / admin123` also exists on the box.)
4. Activate: generate a key in **KeyMaster** (MONTHLY / QUARTERLY / ANNUAL /
   LIFETIME) and paste it on the activation screen. Until then every ERP
   screen answers "activation required".
5. Rotate the `admin` password, create the shop's real users
   (cashier / manager roles).
6. Run `Add-Firewall-Rule.bat` (right-click → Run as administrator) so other
   tills can connect. Tills open `http://<host>:3030` — no install needed.
7. Walk the shop through one sale + one Z-report before you leave.

## KeyMaster (your side of the deal)

- Sign in with your **platform (super-admin)** account and your Control
  Tower URL. Shop logins are refused.
- **Keys** → generate → copy the code to the customer (WhatsApp/email).
- **Connected** → which shops have a live session right now (auto-refresh
  every 30 s; presence window is 5 minutes).
- **Tenants** → block a non-paying shop, extend a licence (30/90/365 days).
- Presence is written by the ERP itself (`sessions.last_seen_at`,
  throttled to one write per minute) — nothing leaves the shop PC except
  normal API traffic to your Control Tower.

## 5-minute demo script

1. Setup wizard → company + owner login (30 s).
2. Paste activation key → ERP unlocks (30 s).
3. Stock: create one product, receive 20 units (1 min).
4. POS: open shift with float, scan/type the product, take cash, print
   receipt (ESC/POS via USB, or system print dialog) (2 min).
5. End of day: X-report, Z-close, show the variance box (1 min).
6. Settings → Backup → show the snapshot list; mention the 24h rotation.

## Support playbook

- `GET /api/v1/health` — public liveness: version + storage phase. Tills can
  also use it to check the host is up.
- Launcher window doubles as the log (one line per request). `Ctrl+C` stops
  the server.
- Port conflict: `set PORT=3031` then relaunch (and redo the firewall rule).
- Data lives in `data\` next to `GraySale.bat`; snapshots in `data\backups\`.
  Updates = unpack the new zip over the same folder; `data\` is untouched.
- License expired/blocked: Control Tower → tenant → extend or unblock.

## Known v1 caveats (say nothing, but know them)

- Licensing is enforced locally on the shop PC (the gate is real, but the
  box owner could mint keys themselves via Control Tower). Acceptable for
  the first customers; a signed-key scheme is the planned hardening.
- LAN traffic is plain HTTP. Fine on a trusted shop LAN; never port-forward
  the box to the internet.
- The bootstrap `admin` is the platform super-admin — always rotate the
  password during handover.
