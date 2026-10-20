import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api.dart';
import '../widgets.dart';

const _planTypes = ['LIFETIME', 'ANNUAL', 'QUARTERLY', 'MONTHLY'];

const _statusFilters = <String, String>{
  'All statuses': '',
  'Unused': 'UNUSED',
  'Redeemed': 'REDEEMED',
  'Revoked': 'REVOKED',
};

class KeysScreen extends StatefulWidget {
  const KeysScreen({
    super.key,
    required this.client,
    required this.onSessionExpired,
  });

  final ApiClient client;
  final VoidCallback onSessionExpired;

  @override
  State<KeysScreen> createState() => _KeysScreenState();
}

class _KeysScreenState extends State<KeysScreen>
    with AutomaticKeepAliveClientMixin {
  List<Map<String, dynamic>>? _keys;
  String _search = '';
  String _status = '';
  bool _loading = true;
  bool _generating = false;
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
    setState(() => _loading = _keys == null);
    try {
      final keys = await widget.client.listKeys(
        status: _status,
        search: _search,
      );
      if (!mounted) return;
      setState(() {
        _keys = keys;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
      _onApiError(e);
    }
  }

  Future<void> _openGenerateDialog() async {
    var planType = _planTypes.first;
    var count = 1;
    final countController = TextEditingController(text: '1');

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('Generate keys'),
          content: SizedBox(
            width: 360,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DropdownButtonFormField<String>(
                  initialValue: planType,
                  decoration: const InputDecoration(
                    labelText: 'Plan type',
                    border: OutlineInputBorder(),
                    isDense: true,
                  ),
                  items: [
                    for (final p in _planTypes)
                      DropdownMenuItem(
                        value: p,
                        child: Text(switch (p) {
                          'LIFETIME' => 'Lifetime',
                          'ANNUAL' => 'Annual (365 days)',
                          'QUARTERLY' => 'Quarterly (90 days)',
                          _ => 'Monthly (30 days)',
                        }),
                      ),
                  ],
                  onChanged: (v) =>
                      setDialogState(() => planType = v ?? planType),
                ),
                const SizedBox(height: 16),
                Text('Count', style: Theme.of(ctx).textTheme.labelMedium),
                const SizedBox(height: 8),
                Row(
                  children: [
                    IconButton(
                      onPressed: count > 1
                          ? () => setDialogState(() {
                              count--;
                              countController.text = '$count';
                            })
                          : null,
                      icon: const Icon(Icons.remove),
                    ),
                    SizedBox(
                      width: 80,
                      child: TextFormField(
                        controller: countController,
                        textAlign: TextAlign.center,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(
                          border: OutlineInputBorder(),
                          isDense: true,
                        ),
                        onChanged: (v) {
                          final n = int.tryParse(v);
                          if (n != null && n >= 1 && n <= 100) {
                            setDialogState(() => count = n);
                          }
                        },
                      ),
                    ),
                    IconButton(
                      onPressed: count < 100
                          ? () => setDialogState(() {
                              count++;
                              countController.text = '$count';
                            })
                          : null,
                      icon: const Icon(Icons.add),
                    ),
                    const SizedBox(width: 8),
                    Text('1–100', style: Theme.of(ctx).textTheme.bodySmall),
                  ],
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('Generate'),
            ),
          ],
        ),
      ),
    );
    countController.dispose();

    if (confirmed != true || !mounted) return;
    setState(() => _generating = true);
    try {
      final generated = await widget.client.generateKeys(
        planType: planType,
        count: count,
      );
      if (!mounted) return;
      setState(() => _generating = false);
      await _showGeneratedDialog(generated);
      await _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _generating = false);
      _onApiError(e);
    }
  }

  Future<void> _showGeneratedDialog(List<GeneratedKey> keys) async {
    final codes = keys.map((k) => k.keyCode).join('\n');
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('${keys.length} key(s) generated'),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Ready to distribute:',
                style: Theme.of(ctx).textTheme.bodySmall,
              ),
              const SizedBox(height: 12),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Theme.of(ctx).colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: SelectableText(
                  codes,
                  style: const TextStyle(
                    fontFamily: 'Consolas',
                    fontSize: 14,
                    height: 1.6,
                  ),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton.icon(
            icon: const Icon(Icons.copy, size: 18),
            label: const Text('Copy all'),
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: codes));
              if (ctx.mounted) {
                ScaffoldMessenger.of(ctx).showSnackBar(
                  const SnackBar(content: Text('Copied to clipboard')),
                );
              }
            },
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final keys = _keys;
    return Scaffold(
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(24, 24, 24, 0),
            child: Row(
              children: [
                Text('Keys', style: Theme.of(context).textTheme.headlineSmall),
                const SizedBox(width: 24),
                SizedBox(
                  width: 280,
                  child: TextField(
                    controller: _searchController,
                    decoration: InputDecoration(
                      hintText: 'Search key code…',
                      prefixIcon: const Icon(Icons.search),
                      border: const OutlineInputBorder(),
                      isDense: true,
                      suffixIcon: _search.isNotEmpty
                          ? IconButton(
                              icon: const Icon(Icons.clear),
                              onPressed: () {
                                _searchControllerClear();
                              },
                            )
                          : null,
                    ),
                    onChanged: _onSearchChanged,
                    onSubmitted: (_) => _load(),
                  ),
                ),
                const SizedBox(width: 12),
                SizedBox(
                  width: 180,
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
                const SizedBox(width: 12),
                FilledButton.icon(
                  onPressed: _generating ? null : _openGenerateDialog,
                  icon: _generating
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.add),
                  label: const Text('Generate keys'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          Expanded(
            child: keys == null && _loading
                ? const Center(child: CircularProgressIndicator())
                : keys == null || keys.isEmpty
                ? const EmptyState('No keys match this filter.')
                : ListView.separated(
                    padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
                    itemCount: keys.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (ctx, i) => _KeyRow(keyData: keys[i]),
                  ),
          ),
        ],
      ),
    );
  }

  void _searchControllerClear() {
    _searchController.clear();
    _debounce?.cancel();
    setState(() => _search = '');
    _load();
  }
}

class _KeyRow extends StatelessWidget {
  const _KeyRow({required this.keyData});

  final Map<String, dynamic> keyData;

  @override
  Widget build(BuildContext context) {
    final code = keyData['key_code']?.toString() ?? '-';
    final plan = keyData['plan_type']?.toString() ?? '-';
    final tenant = keyData['tenant_name']?.toString();
    final usedAt = keyData['used_at']?.toString();
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        children: [
          SizedBox(
            width: 260,
            child: Text(
              code,
              style: const TextStyle(
                fontFamily: 'Consolas',
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          SizedBox(
            width: 120,
            child: StatusChip(keyData['status']?.toString()),
          ),
          SizedBox(
            width: 110,
            child: Text(plan, style: TextStyle(color: scheme.onSurfaceVariant)),
          ),
          Expanded(
            child: Text(
              tenant ?? '—',
              style: TextStyle(color: scheme.onSurfaceVariant),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          SizedBox(
            width: 150,
            child: Text(
              usedAt == null ? '-' : fmtDate(usedAt),
              style: TextStyle(color: scheme.outline, fontSize: 13),
            ),
          ),
          IconButton(
            tooltip: 'Copy key',
            icon: const Icon(Icons.copy, size: 18),
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: code));
              if (context.mounted) {
                ScaffoldMessenger.of(
                  context,
                ).showSnackBar(SnackBar(content: Text('Copied $code')));
              }
            },
          ),
        ],
      ),
    );
  }
}
