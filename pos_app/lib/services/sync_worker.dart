import 'package:workmanager/workmanager.dart';

import 'api_client.dart';
import 'local_store.dart';
import 'prefs_token_store.dart';
import 'sync_service.dart';

/// Entry point executed by the OS in a background isolate.
///
/// Rebuilds a minimal stack (token store → api client → local store → sync
/// service) because the isolate has no access to the widget tree. A failed run
/// returns false so Workmanager can apply its retry policy; the queue is never
/// lost because synced ids are only removed after the server acks them.
@pragma('vm:entry-point')
void syncCallbackDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    try {
      final store = await SqliteLocalStore.open();
      final api = ApiClient(tokenStore: PrefsTokenStore());
      await api.loadToken();
      if (api.token == null) return false; // not logged in; retry later
      final result = await SyncService(api: api, store: store).syncNow();
      return result.ok;
    } catch (_) {
      return false;
    }
  });
}

/// Registers the periodic background task. Call once from `main()`.
Future<void> registerSyncWorker() async {
  await Workmanager().initialize(syncCallbackDispatcher);
  await Workmanager().registerPeriodicTask(
    'pos-periodic-sync',
    'syncSales',
    frequency: const Duration(minutes: 15),
    constraints: Constraints(networkType: NetworkType.connected),
    existingWorkPolicy: ExistingPeriodicWorkPolicy.update,
  );
}