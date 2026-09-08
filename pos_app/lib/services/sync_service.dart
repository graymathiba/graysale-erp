import 'api_client.dart';
import 'local_store.dart';

/// Result of a sync run.
class SyncResult {
  const SyncResult({this.synced = const [], this.duplicates = const [], this.failures = const [], this.error});

  final List<String> synced;
  final List<String> duplicates;
  final List<String> failures;
  final String? error;

  bool get ok => error == null && failures.isEmpty;
  int get total => synced.length + duplicates.length + failures.length;
}

/// Orchestrates the offline-first push: reads unsynced sales from [LocalStore],
/// posts them (idempotently) to the ERP via [ApiClient], and marks the ids the
/// server confirmed as synced. Re-runnable at any time; server-side dedupe by
/// local id means a retry after a partial failure never double-charges.
class SyncService {
  SyncService({required ApiClient api, required LocalStore store}) {
    _api = api;
    _store = store;
  }

  late final ApiClient _api;
  late final LocalStore _store;

  Future<SyncResult> syncNow() async {
    final pending = await _store.pendingSales();
    if (pending.isEmpty) {
      return const SyncResult();
    }

    final payload = pending.map((s) => s.toSyncJson()).toList();
    try {
      final res = await _api.syncSales(payload);
      final synced = res.syncedIds;
      final kept = <String>[];

      for (final sale in pending) {
        if (synced.contains(sale.id)) {
          await _store.markSynced(sale.id);
        } else if (!res.duplicates.contains(sale.id)) {
          // Server neither confirmed nor deduped this one — keep it queued.
          kept.add(sale.id);
        }
      }
      // Duplicates are already applied server-side on a prior attempt; treat
      // them as synced so a flaky first response can't wedge the queue.
      for (final d in res.duplicates) {
        await _store.markSynced(d);
      }

      if (kept.isNotEmpty) {
        return SyncResult(synced: synced, duplicates: res.duplicates, failures: kept, error: 'server did not acknowledge some sales');
      }
      return SyncResult(synced: synced, duplicates: res.duplicates);
    } catch (e) {
      // Network/app error: nothing was acked, leave everything queued.
      return SyncResult(failures: pending.map((s) => s.id).toList(), error: e.toString());
    }
  }
}