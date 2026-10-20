import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../widgets.dart';

class ConnectedScreen extends StatefulWidget {
  const ConnectedScreen({
    super.key,
    required this.client,
    required this.onSessionExpired,
  });

  final ApiClient client;
  final VoidCallback onSessionExpired;

  @override
  State<ConnectedScreen> createState() => _ConnectedScreenState();
}

class _ConnectedScreenState extends State<ConnectedScreen>
    with AutomaticKeepAliveClientMixin {
  ConnectedResult? _data;
  bool _loading = true;
  Timer? _timer;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(
      const Duration(seconds: 30),
      (_) => _load(silent: true),
    );
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent) setState(() => _loading = _data == null);
    try {
      final data = await widget.client.connected();
      if (!mounted) return;
      setState(() {
        _data = data;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
      if (e.sessionExpired) {
        widget.onSessionExpired();
      } else if (!silent) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final data = _data;
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: data == null && _loading
          ? const Center(child: CircularProgressIndicator())
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 24, 24, 0),
                  child: Row(
                    children: [
                      Text(
                        'Connected',
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                      const SizedBox(width: 16),
                      Text(
                        'Shops with a session in the last ${((data?.windowMs ?? 300000) / 60000).round()} minutes',
                        style: Theme.of(
                          context,
                        ).textTheme.bodySmall?.copyWith(color: scheme.outline),
                      ),
                      const Spacer(),
                      if (data?.checkedAt != null)
                        Text(
                          'Checked at ${fmtDateTime(data!.checkedAt)}',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      const SizedBox(width: 12),
                      IconButton.filledTonal(
                        tooltip: 'Refresh',
                        onPressed: _loading ? null : () => _load(),
                        icon: _loading
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.refresh),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                Expanded(
                  child: data == null
                      ? const EmptyState(
                          'Unable to load connected shops — tap refresh to retry.',
                        )
                      : data.tenants.isEmpty
                      ? EmptyState(
                          'No shops checked in during the last '
                          '${(data.windowMs / 60000).round()} minutes.',
                          icon: Icons.wifi_off_outlined,
                        )
                      : ListView.separated(
                          padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
                          itemCount: data.tenants.length,
                          separatorBuilder: (_, _) => const Divider(height: 1),
                          itemBuilder: (ctx, i) {
                            final t = data.tenants[i];
                            final lastSeenMs = t['lastSeenAt'];
                            final lastSeen = lastSeenMs is num
                                ? DateTime.fromMillisecondsSinceEpoch(
                                    lastSeenMs.toInt(),
                                  )
                                : null;
                            final sessions = t['sessions'];
                            return Padding(
                              padding: const EdgeInsets.symmetric(vertical: 12),
                              child: Row(
                                children: [
                                  Icon(
                                    Icons.store,
                                    color: scheme.primary,
                                    size: 28,
                                  ),
                                  const SizedBox(width: 14),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          t['companyName']?.toString() ?? '-',
                                          style: const TextStyle(
                                            fontWeight: FontWeight.w600,
                                          ),
                                        ),
                                        Text(
                                          'Last seen ${relativeTime(lastSeen)}',
                                          style: TextStyle(
                                            color: scheme.outline,
                                            fontSize: 12,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                  SizedBox(
                                    width: 170,
                                    child: StatusChip(t['status']?.toString()),
                                  ),
                                  SizedBox(
                                    width: 120,
                                    child: Text(
                                      '${sessions ?? '-'} session${sessions == 1 ? '' : 's'}',
                                      style: TextStyle(
                                        color: scheme.onSurfaceVariant,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            );
                          },
                        ),
                ),
              ],
            ),
    );
  }
}
