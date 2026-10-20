import 'package:flutter/material.dart';

import 'api.dart';
import 'screens/connected_screen.dart';
import 'screens/dashboard_screen.dart';
import 'screens/keys_screen.dart';
import 'screens/login_screen.dart';
import 'screens/tenants_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const KeyMasterApp());
}

class KeyMasterApp extends StatefulWidget {
  const KeyMasterApp({super.key});

  @override
  State<KeyMasterApp> createState() => _KeyMasterAppState();
}

class _KeyMasterAppState extends State<KeyMasterApp> {
  ApiClient? _client;
  String _username = '';

  void _signIn(ApiClient client, String username) {
    setState(() {
      _client = client;
      _username = username;
    });
  }

  void _signOut({String? reason}) {
    setState(() {
      _client = null;
      _username = '';
    });
    if (reason != null && mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(reason)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final client = _client;
    return MaterialApp(
      title: 'GraySale KeyMaster',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF3D5A80),
          brightness: Brightness.light,
        ),
        visualDensity: VisualDensity.comfortable,
      ),
      home: client == null
          ? LoginScreen(onSignedIn: _signIn)
          : HomeShell(
              client: client,
              username: _username,
              onSignOut: () => _signOut(),
              onSessionExpired: () =>
                  _signOut(reason: 'Session expired — please sign in again.'),
            ),
    );
  }
}

class HomeShell extends StatefulWidget {
  const HomeShell({
    super.key,
    required this.client,
    required this.username,
    required this.onSignOut,
    required this.onSessionExpired,
  });

  final ApiClient client;
  final String username;
  final VoidCallback onSignOut;
  final VoidCallback onSessionExpired;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  static const _destinations = [
    (Icons.dashboard_outlined, Icons.dashboard, 'Dashboard'),
    (Icons.vpn_key_outlined, Icons.vpn_key, 'Keys'),
    (Icons.storefront_outlined, Icons.storefront, 'Tenants'),
    (Icons.wifi_tethering_outlined, Icons.wifi_tethering, 'Connected'),
  ];

  @override
  Widget build(BuildContext context) {
    final client = widget.client;
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: Row(
        children: [
          NavigationRail(
            selectedIndex: _index,
            onDestinationSelected: (i) => setState(() => _index = i),
            extended: true,
            minExtendedWidth: 180,
            leading: const Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: Icon(Icons.key, size: 32),
            ),
            labelType: NavigationRailLabelType.none,
            destinations: [
              for (final (icon, selectedIcon, label) in _destinations)
                NavigationRailDestination(
                  icon: Icon(icon),
                  selectedIcon: Icon(selectedIcon),
                  label: Text(label),
                ),
            ],
            trailing: Expanded(
              child: Align(
                alignment: Alignment.bottomCenter,
                child: Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Divider(indent: 16, endIndent: 16),
                      const SizedBox(height: 8),
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        child: Text(
                          widget.username,
                          style: Theme.of(context).textTheme.bodySmall,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      IconButton(
                        tooltip: 'Sign out',
                        onPressed: widget.onSignOut,
                        icon: const Icon(Icons.logout),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          VerticalDivider(width: 1, color: scheme.outlineVariant),
          Expanded(
            child: IndexedStack(
              index: _index,
              children: [
                DashboardScreen(
                  client: client,
                  onSessionExpired: widget.onSessionExpired,
                ),
                KeysScreen(
                  client: client,
                  onSessionExpired: widget.onSessionExpired,
                ),
                TenantsScreen(
                  client: client,
                  onSessionExpired: widget.onSessionExpired,
                ),
                ConnectedScreen(
                  client: client,
                  onSessionExpired: widget.onSessionExpired,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
