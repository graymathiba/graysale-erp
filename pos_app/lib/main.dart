import 'package:flutter/material.dart';

import 'screens/login_screen.dart';
import 'screens/pos_home_screen.dart';
import 'services/api_client.dart';
import 'services/local_store.dart';
import 'services/prefs_token_store.dart';
import 'services/sync_service.dart';
import 'services/sync_worker.dart';
import 'state/cart_notifier.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Periodic background sync (Android/iOS). Non-fatal if unsupported.
  await registerSyncWorker();
  runApp(PosApp());
}

class PosApp extends StatefulWidget {
  const PosApp({super.key});

  @override
  State<PosApp> createState() => _PosAppState();
}

class _PosAppState extends State<PosApp> {
  late final ApiClient _api;
  late final LocalStore _store;
  late final SyncService _sync;
  late final CartNotifier _cart;
  bool? _hasToken;

  @override
  void initState() {
    super.initState();
    _api = ApiClient(tokenStore: PrefsTokenStore());
    // SqliteLocalStore.open is async; resolve before first frame.
    _boot();
  }

  Future<void> _boot() async {
    _store = await SqliteLocalStore.open();
    await _api.loadToken();
    _sync = SyncService(api: _api, store: _store);
    _cart = CartNotifier();
    if (!mounted) return;
    setState(() => _hasToken = _api.token != null);
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Graysale POS',
      theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo), useMaterial3: true),
      initialRoute: '/login',
      routes: {
        '/login': (_) => LoginScreen(api: _api),
        '/home': (_) => _home(),
      },
      home: _hasToken == null
          ? const Scaffold(body: Center(child: CircularProgressIndicator()))
          : (_hasToken == true ? _home() : LoginScreen(api: _api)),
    );
  }

  Widget _home() => PosHomeScreen(api: _api, store: _store, cart: _cart, sync: _sync);
}