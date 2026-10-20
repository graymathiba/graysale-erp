import 'package:flutter/material.dart';

import '../api.dart';
import '../widgets.dart';

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({
    super.key,
    required this.client,
    required this.onSessionExpired,
  });

  final ApiClient client;
  final VoidCallback onSessionExpired;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen>
    with AutomaticKeepAliveClientMixin {
  Map<String, dynamic>? _data;
  DateTime? _lastUpdated;
  bool _loading = true;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = _data == null);
    try {
      final data = await widget.client.overview();
      if (!mounted) return;
      setState(() {
        _data = data;
        _lastUpdated = DateTime.now();
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
      if (e.sessionExpired) {
        widget.onSessionExpired();
      } else {
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
    return Scaffold(
      body: data == null && _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(24),
                children: [
                  Row(
                    children: [
                      Text(
                        'Dashboard',
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                      const Spacer(),
                      if (_lastUpdated != null)
                        Text(
                          'Updated ${fmtDateTime(_lastUpdated)}',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      const SizedBox(width: 12),
                      IconButton.filledTonal(
                        tooltip: 'Refresh',
                        onPressed: _loading ? null : _load,
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
                  const SizedBox(height: 24),
                  if (data != null) ...[
                    Text(
                      'Companies',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 12),
                    Wrap(
                      spacing: 12,
                      runSpacing: 12,
                      children: [
                        _card(
                          'Total Companies',
                          data['totalCompanies'],
                          Colors.blue,
                        ),
                        _card(
                          'Active',
                          data['activeCompanies'],
                          const Color(0xFF2E7D32),
                        ),
                        _card(
                          'Blocked',
                          data['blockedInstances'],
                          const Color(0xFFC62828),
                        ),
                        _card(
                          'Expired',
                          data['expiredAccounts'],
                          const Color(0xFFEF6C00),
                        ),
                        _card(
                          'Pending Activation',
                          data['pendingKeys'],
                          const Color(0xFF6A1B9A),
                        ),
                      ],
                    ),
                    const SizedBox(height: 28),
                    Text(
                      'Product keys',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 12),
                    Wrap(
                      spacing: 12,
                      runSpacing: 12,
                      children: [
                        _card(
                          'Generated',
                          data['totalGenerated'],
                          const Color(0xFF6A1B9A),
                        ),
                        _card(
                          'Redeemed',
                          data['redeemed'],
                          const Color(0xFF2E7D32),
                        ),
                        _card(
                          'Unused',
                          data['unused'],
                          const Color(0xFF1565C0),
                        ),
                        _card('Revoked', data['revoked'], Colors.grey.shade700),
                      ],
                    ),
                  ] else if (!_loading) ...[
                    EmptyState(
                      'Unable to load overview — tap refresh to retry.',
                      icon: Icons.error_outline,
                    ),
                  ],
                ],
              ),
            ),
    );
  }

  Widget _card(String label, Object? value, Color color) {
    return SizedBox(
      width: 180,
      child: MetricCard(
        label: label,
        value: value == null ? '-' : value.toString(),
        color: color,
      ),
    );
  }
}
