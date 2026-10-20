import 'package:flutter/material.dart';

import '../open_browser.dart';
import '../server_paths.dart';

/// Shown when the GraySaleServer bundle is missing next to the exe. Explains
/// the expected layout and offers to open the browser anyway (useful when a
/// server is already running from another install).
class SetupErrorScreen extends StatelessWidget {
  const SetupErrorScreen({
    super.key,
    required this.port,
    required this.onRetry,
  });

  final int port;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final exeDir = ServerPaths.exeDir;
    final tree = [
      '$exeDir\\',
      '├── graysale_desktop.exe',
      '└── GraySaleServer\\',
      '    ├── node\\',
      '    │   └── node.exe',
      '    └── app\\',
      '        ├── src\\',
      '        │   └── server.js',
      '        └── web\\',
      '            └── dist\\',
      '                └── index.html',
    ].join('\n');

    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 680),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(Icons.folder_off_rounded,
                      size: 40, color: theme.colorScheme.error),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text('Server files not found',
                        style: theme.textTheme.headlineSmall),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              const Text(
                'GraySale could not find its bundled server folder. '
                'The server must sit next to graysale_desktop.exe with this layout:',
              ),
              const SizedBox(height: 12),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surfaceContainerLow,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: theme.colorScheme.outlineVariant),
                ),
                child: SelectableText(
                  tree,
                  style: const TextStyle(fontFamily: 'Consolas', fontSize: 13),
                ),
              ),
              const SizedBox(height: 12),
              SelectableText(
                'Expected location: ${ServerPaths.serverRoot}',
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
              ),
              const SizedBox(height: 24),
              Wrap(
                spacing: 12,
                runSpacing: 12,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  FilledButton.icon(
                    onPressed: () => openInBrowser(port),
                    icon: const Icon(Icons.open_in_new),
                    label: const Text('Open browser anyway'),
                  ),
                  OutlinedButton.icon(
                    onPressed: onRetry,
                    icon: const Icon(Icons.refresh),
                    label: const Text('Retry'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
