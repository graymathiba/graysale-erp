# Graysale POS (offline-first Flutter client)

A Flutter point-of-sale client that keeps working when the network is down and
drains its offline queue to the ERP automatically.

## Architecture

```
POS checkout ──> SqliteLocalStore (sqlite queue, durable first)
                     │
                     ▼
                  SyncService ──> POST /api/v1/sync/sales  (idempotent)
                     │
                     ▼
               marks local ids synced on server ack
```

**Offline-first flow**

1. Every checkout is written to the local SQLite `pending_sales` queue *before*
   any network call — durability first.
2. `SyncService` reads unsynced rows and pushes them to
   `POST /api/v1/sync/sales` in one batch.
3. The server is **idempotent by the client-supplied `id`** (a UUID). Re-sending
   the same sale after a network drop never creates a duplicate receipt.
4. Only ids the server explicitly acknowledges (`syncedIds`, and `duplicates`
   from an earlier attempt) are marked `synced`. A failed/partial run leaves the
   rest queued for the next attempt.

**Background sync** (`lib/services/sync_worker.dart`) registers a Workmanager
periodic task (every 15 min, network-connected constraint) that drains the queue
in a background isolate. A manual "Sync" button in the app does the same on
demand.

## Run

```sh
flutter pub get

# Point at your ERP on the LAN (default targets the Android emulator host):
flutter run --dart-define=API_BASE_URL=http://192.168.100.10:3000
```

The backend URL is configured via the `API_BASE_URL` dart-define (see
`lib/config.dart`). Defaults to `http://10.0.2.2:3000` (host machine as seen
from the Android emulator).

## Backend requirements

- `POST /api/v1/auth/login` → `{ ok, token }`; token sent as
  `Authorization: Bearer <token>`.
- `GET /api/v1/products` → list of products with `id`, `name`, `price_cents`.
- `POST /api/v1/sync/sales` body `{ sales: [{ id, total_cents, payment_method,
  created_at, lines: [...] }] }` → `{ success, syncedIds, duplicates }`.

## Tests

```sh
flutter analyze
flutter test
```

Coverage: cart logic, sale model JSON round-trip, idempotency key generation,
and the sync service (ack, dedupe, network-failure retry, unacknowledged
retention) using fakes.
