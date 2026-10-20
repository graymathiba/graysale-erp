import 'package:flutter/material.dart';

/// Shown when the spawned server never became healthy: explains the failure,
/// shows the captured log tail, and offers a Retry.
class FailureScreen extends StatelessWidget {
  const FailureScreen({
    super.key,
    required this.message,
    required this.logTail,
    required this.onRetry,
  });

  final String message;
  final String logTail;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 760),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Icon(Icons.error_outline_rounded,
                      size: 40, color: theme.colorScheme.error),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text('Server failed to start',
                        style: theme.textTheme.headlineSmall),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Text(message, style: theme.textTheme.bodyMedium),
              const SizedBox(height: 16),
              Text(
                'Last server output:',
                style: theme.textTheme.bodySmall
                    ?.copyWith(fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              Container(
                height: 260,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surfaceContainerLow,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: theme.colorScheme.outlineVariant),
                ),
                child: SingleChildScrollView(
                  child: SelectableText(
                    logTail.isEmpty ? 'No output was captured.' : logTail,
                    style: const TextStyle(fontFamily: 'Consolas', fontSize: 12),
                  ),
                ),
              ),
              const SizedBox(height: 20),
              Align(
                alignment: Alignment.centerLeft,
                child: FilledButton.icon(
                  onPressed: onRetry,
                  icon: const Icon(Icons.refresh),
                  label: const Text('Retry'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
