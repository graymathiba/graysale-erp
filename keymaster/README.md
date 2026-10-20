# GraySale KeyMaster

A Windows desktop (Flutter) tool for the **GraySale vendor / platform admin**. It is
completely separate from the ERP apps — it talks straight to a Control Tower
instance's super-admin API and lets you:

- **Dashboard** — platform metrics: total/active/blocked/expired/pending companies
  plus product-key inventory (generated / redeemed / unused / revoked).
- **Keys** — search and filter product keys, generate new ones (plan type +
  quantity), copy freshly generated key codes to the clipboard.
- **Tenants** — list shops with status chips, block/unblock access, extend
  licenses by 30/90/365 days or a custom number of days.
- **Connected** — live view of which shops have a session in the last 5 minutes
  (sessions count, last seen, auto-refreshes every 30 s).

Only **super-admin** accounts can use it; regular logins are rejected.

## Pointing it at your Control Tower

1. Launch KeyMaster.
2. On the sign-in screen, set **Control Tower URL** — the base URL of the
   graysale server, e.g. `https://localhost:3030` (the default) or
   `https://your-server.example.com:3030`.
3. Sign in with a platform (super-admin) username and password.

The URL is persisted between launches (shared_preferences). The password and
session token are **never** stored.

## Build

```powershell
flutter pub get
flutter build windows --release
```

Output: `build\windows\x64\runner\Release\keymaster.exe`

Requires the Flutter SDK (Windows desktop) with Visual Studio C++ desktop
workload installed.
