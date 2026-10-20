import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../widgets.dart';

const _statusFilters = <String, String>{
  'All statuses': '',
  'Active': 'ACTIVE',
  'Pending Activation': 'PENDING_ACTIVATION',
  'Blocked': 'BLOCKED',
  'Expired': 'EXPIRED',
  'Pending Key': 'PENDING_KEY',
};

class TenantsScreen extends StatefulWidget {
  const TenantsScreen({
    super.key,
    required this.client,
    required this.onSessionExpired,
  });

  final ApiClient client;
  final VoidCallback onSessionExpired;

  @override
  State<TenantsScreen> createState() => _TenantsScreenState();
}

class _TenantsScreenState extends State<TenantsScreen>
    with AutomaticKeepAliveClientMixin {
  List<Map<String, dynamic>>? _tenants;
  String _search = '';
  String _status = '';
  bool _loading = true;
  String? _busyId;
  Timer? _debounce;
  final _searchController = TextEditingController();

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _searchController.dispose();
    super.dispose();
  }

  void _onSearchChanged(String value) {
    setState(() => _search = value.trim());
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), _load);
  }

  void _onApiError(ApiException e) {
    if (!mounted) return;
    if (e.sessionExpired) {
      widget.onSessionExpired();
    } else {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _load() async {
    setState(() => _loading = _tenants == null);
    try {
      final tenants = await widget.client.listTenants(
        search: _search,
        status: _status,
      );
      if (!mounted) return;
      setState(() {
        _tenants = tenants;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
      _onApiError(e);
    }
  }

  Future<void> _toggle(Map<String, dynamic> t) async {
    final id = t['id']?.toString();
    if (id == null) return;
    setState(() => _busyId = id);
    try {
      final next = await widget.client.toggleTenant(id);
      if (!mounted) return;
      final name =
          next['company_name']?.toString() ??
          t['company_name']?.toString() ??
          '-';
      final blocked = next['status'] == 'BLOCKED';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(blocked ? '$name blocked' : '$name unblocked')),
      );
      await _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      _onApiError(e);
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  Future<void> _openExtendDialog(Map<String, dynamic> t) async {
    final days = await showDialog<int>(
      context: context,
      builder: (ctx) => _ExtendDialog(
        companyName: t['company_name']?.toString() ?? '-',
        currentExpiry: t['license_expires_at']?.toString(),
      ),
    );
    if (days == null || !mounted) return;
    final id = t['id']?.toString();
    if (id == null) return;
    setState(() => _busyId = id);
    try {
      final next = await widget.client.extendTenant(id, days);
      if (!mounted) return;
      final name =
          next['company_name']?.toString() ??
          t['company_name']?.toString() ??
          '-';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Extended $name by $days day(s) → ${fmtDate(next['license_expires_at'])}',
          ),
        ),
      );
      await _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      _onApiError(e);
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final tenants = _tenants;
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(24, 24, 24, 0),
            child: Row(
              children: [
                Text(
                  'Tenants',
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const SizedBox(width: 24),
                SizedBox(
                  width: 300,
                  child: TextField(
                    controller: _searchController,
                    decoration: const InputDecoration(
                      hintText: 'Search company…',
                      prefixIcon: Icon(Icons.search),
                      border: OutlineInputBorder(),
                      isDense: true,
                    ),
                    onChanged: _onSearchChanged,
                    onSubmitted: (_) => _load(),
                  ),
                ),
                const SizedBox(width: 12),
                SizedBox(
                  width: 200,
                  child: DropdownButtonFormField<String>(
                    initialValue: _status,
                    decoration: const InputDecoration(
                      border: OutlineInputBorder(),
                      isDense: true,
                    ),
                    items: [
                      for (final e in _statusFilters.entries)
                        DropdownMenuItem(value: e.value, child: Text(e.key)),
                    ],
                    onChanged: (v) {
                      setState(() => _status = v ?? '');
                      _load();
                    },
                  ),
                ),
                const Spacer(),
                OutlinedButton.icon(
                  onPressed: _load,
                  icon: const Icon(Icons.refresh),
                  label: const Text('Refresh'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          Expanded(
            child: tenants == null && _loading
                ? const Center(child: CircularProgressIndicator())
                : tenants == null || tenants.isEmpty
                ? const EmptyState('No companies found.')
                : ListView.separated(
                    padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
                    itemCount: tenants.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (ctx, i) {
                      final t = tenants[i];
                      final id = t['id']?.toString() ?? '';
                      final name = t['company_name']?.toString() ?? '-';
                      final status = t['status']?.toString();
                      final expiry = t['license_expires_at']?.toString();
                      final isExpired = t['isExpired'] == true;
                      final busy = _busyId == id;
                      return Padding(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        child: Row(
                          children: [
                            Expanded(
                              flex: 3,
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    name,
                                    style: const TextStyle(
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                  Text(
                                    t['owner_email']?.toString() ?? '-',
                                    style: TextStyle(
                                      color: scheme.outline,
                                      fontSize: 12,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            SizedBox(width: 170, child: StatusChip(status)),
                            SizedBox(
                              width: 140,
                              child: Text(
                                fmtDate(expiry),
                                style: TextStyle(
                                  color: isExpired
                                      ? scheme.error
                                      : scheme.onSurfaceVariant,
                                  fontWeight: isExpired
                                      ? FontWeight.w600
                                      : null,
                                ),
                              ),
                            ),
                            SizedBox(
                              width: 110,
                              child: busy
                                  ? const SizedBox(
                                      width: 18,
                                      height: 18,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                      ),
                                    )
                                  : OutlinedButton(
                                      onPressed: () => _toggle(t),
                                      child: Text(
                                        status == 'BLOCKED'
                                            ? 'Unblock'
                                            : 'Block',
                                      ),
                                    ),
                            ),
                            const SizedBox(width: 8),
                            SizedBox(
                              width: 100,
                              child: OutlinedButton(
                                onPressed: busy
                                    ? null
                                    : () => _openExtendDialog(t),
                                child: const Text('Extend'),
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

class _ExtendDialog extends StatefulWidget {
  const _ExtendDialog({required this.companyName, this.currentExpiry});

  final String companyName;
  final String? currentExpiry;

  @override
  State<_ExtendDialog> createState() => _ExtendDialogState();
}

class _ExtendDialogState extends State<_ExtendDialog> {
  int? _preset = 30;
  final _customController = TextEditingController();

  @override
  void dispose() {
    _customController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Extend — ${widget.companyName}'),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Current expiry: ${fmtDate(widget.currentExpiry)}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 16),
            Wrap(
              spacing: 8,
              children: [
                for (final days in const [30, 90, 365])
                  ChoiceChip(
                    label: Text('$days days'),
                    selected: _preset == days && _customController.text.isEmpty,
                    onSelected: (_) {
                      setState(() {
                        _preset = days;
                        _customController.clear();
                      });
                    },
                  ),
              ],
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _customController,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: 'Custom days',
                border: OutlineInputBorder(),
                isDense: true,
              ),
              onChanged: (_) => setState(() {}),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () {
            final custom = int.tryParse(_customController.text.trim());
            final days = custom != null && custom > 0 ? custom : _preset;
            if (days == null || days <= 0) return;
            Navigator.of(context).pop(days);
          },
          child: const Text('Extend'),
        ),
      ],
    );
  }
}
