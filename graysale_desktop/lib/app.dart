import 'package:flutter/material.dart';

import 'server_controller.dart';
import 'ui/failure_screen.dart';
import 'ui/setup_error_screen.dart';
import 'ui/splash_screen.dart';
import 'ui/webview_screen.dart';

enum AppView { booting, webview, setupError, failed }

class GraySaleApp extends StatefulWidget {
  const GraySaleApp({super.key});

  @override
  State<GraySaleApp> createState() => _GraySaleAppState();
}

class _GraySaleAppState extends State<GraySaleApp> {
  final ServerController _server = ServerController();
  AppView _view = AppView.booting;
  ServerStartResult? _result;
  final List<String> _statusLines = <String>[];
  String _lastStatus = '';

  @override
  void initState() {
    super.initState();
    _server.addListener(_onServerChanged);
    _boot();
  }

  @override
  void dispose() {
    _server.removeListener(_onServerChanged);
    // Never kill an adopted server; stop() only kills what we spawned.
    _server.stop();
    super.dispose();
  }

  void _onServerChanged() {
    if (!mounted) return;
    final message = _server.statusMessage;
    if (message.isNotEmpty && message != _lastStatus) {
      _lastStatus = message;
      if (_statusLines.length >= 8) _statusLines.removeAt(0);
      _statusLines.add(message);
    }
    setState(() {});
  }

  Future<void> _boot() async {
    setState(() {
      _view = AppView.booting;
      _statusLines.clear();
      _lastStatus = '';
    });
    final result = await _server.start();
    if (!mounted) {
      // Started but the window went away before we could show it: release a
      // server we spawned (never an adopted one).
      if (result.ok && !result.adopted) {
        await _server.stop();
      }
      return;
    }
    setState(() {
      _result = result;
      if (result.ok) {
        _view = AppView.webview;
      } else if (result.failure == ServerFailure.missingBundle) {
        _view = AppView.setupError;
      } else {
        _view = AppView.failed;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'GraySale',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorSchemeSeed: const Color(0xFF00796B),
        useMaterial3: true,
      ),
      home: _buildHome(),
    );
  }

  Widget _buildHome() {
    switch (_view) {
      case AppView.booting:
        return _shell(
          body: SplashScreen(
            statusLines: List<String>.of(_statusLines),
            progressLabel: _server.statusMessage,
          ),
        );
      case AppView.webview:
        return WebViewScreen(server: _server);
      case AppView.setupError:
        return _shell(
          body: SetupErrorScreen(port: _server.port, onRetry: _boot),
        );
      case AppView.failed:
        return _shell(
          body: FailureScreen(
            message: _result?.message ?? 'The server failed to start.',
            logTail: _server.logTail(),
            onRetry: _boot,
          ),
        );
    }
  }

  /// Common chrome for the non-webview screens.
  Widget _shell({required Widget body}) {
    return Scaffold(
      appBar: AppBar(title: const Text('GraySale')),
      body: body,
    );
  }
}
