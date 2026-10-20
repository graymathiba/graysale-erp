import 'package:flutter/material.dart';
import 'package:webview_windows/webview_windows.dart';

import '../open_browser.dart';
import '../server_controller.dart';
import '../server_paths.dart';

/// Full-screen embedded ERP once the local server is healthy.
class WebViewScreen extends StatefulWidget {
  const WebViewScreen({super.key, required this.server});

  final ServerController server;

  @override
  State<WebViewScreen> createState() => _WebViewScreenState();
}

class _WebViewScreenState extends State<WebViewScreen> {
  late final WebviewController _webview;
  bool _webviewReady = false;
  String? _webviewError;

  @override
  void initState() {
    super.initState();
    _webview = WebviewController();
    _initWebview();
  }

  @override
  void dispose() {
    _webview.dispose();
    super.dispose();
  }

  Future<void> _initWebview() async {
    setState(() {
      _webviewReady = false;
      _webviewError = null;
    });
    try {
      await _webview.initialize();
      if (!mounted) return;
      await _webview.loadUrl(ServerPaths.appUrl);
      if (!mounted) return;
      setState(() => _webviewReady = true);
    } catch (e) {
      if (!mounted) return;
      setState(() => _webviewError = e.toString());
    }
  }

  void _reload() {
    if (_webviewReady) {
      _webview.reload();
    } else {
      _initWebview();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('GraySale'),
        actions: [
          ListenableBuilder(
            listenable: widget.server,
            builder: (context, _) {
              final running = widget.server.running;
              return Tooltip(
                message: running
                    ? 'Server running on port ${widget.server.port}'
                    : 'Server not running on port ${widget.server.port}',
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: Center(
                    child: Icon(
                      Icons.circle,
                      size: 14,
                      color: running ? Colors.green.shade600 : Colors.red.shade600,
                    ),
                  ),
                ),
              );
            },
          ),
          IconButton(
            tooltip: 'Reload',
            onPressed: _reload,
            icon: const Icon(Icons.refresh),
          ),
          IconButton(
            tooltip: 'Open in browser',
            onPressed: () => openInBrowser(widget.server.port),
            icon: const Icon(Icons.open_in_new),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: _buildBody(context),
    );
  }

  Widget _buildBody(BuildContext context) {
    if (_webviewError != null) {
      return _WebViewFallback(
        error: _webviewError!,
        port: widget.server.port,
        onRetry: _initWebview,
      );
    }
    if (!_webviewReady) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(),
            SizedBox(height: 16),
            Text('Loading interface…'),
          ],
        ),
      );
    }
    return Webview(_webview);
  }
}

/// Shown when WebView2 cannot start (typically the Evergreen Runtime is not
/// installed). Keeps the window — and the local server — alive while the
/// user works in the default browser instead.
class _WebViewFallback extends StatelessWidget {
  const _WebViewFallback({
    required this.error,
    required this.port,
    required this.onRetry,
  });

  final String error;
  final int port;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Icon(Icons.public_off_rounded,
                  size: 48, color: theme.colorScheme.primary),
              const SizedBox(height: 16),
              Text(
                'Embedded browser unavailable',
                textAlign: TextAlign.center,
                style: theme.textTheme.headlineSmall,
              ),
              const SizedBox(height: 12),
              Text(
                'This app embeds the GraySale interface with the Microsoft '
                'Edge WebView2 runtime, which could not be started. '
                'Install the "WebView2 Runtime" (Evergreen) from Microsoft, '
                'or continue in your default browser — the local server keeps '
                'running for as long as this window stays open.',
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium,
              ),
              const SizedBox(height: 8),
              Text(
                error,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
              ),
              const SizedBox(height: 24),
              FilledButton.icon(
                onPressed: () => openInBrowser(port),
                icon: const Icon(Icons.open_in_new),
                label: const Text('Open in browser'),
              ),
              const SizedBox(height: 8),
              TextButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
                label: const Text('Retry'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
