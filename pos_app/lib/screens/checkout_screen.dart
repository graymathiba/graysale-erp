import 'package:flutter/material.dart';

import '../models/sale.dart';
import '../services/api_client.dart';
import '../services/local_store.dart';
import '../services/sync_service.dart';
import '../state/cart_notifier.dart';
import '../util/uuid.dart';

class CheckoutScreen extends StatefulWidget {
  const CheckoutScreen({super.key, required this.cart, required this.store, required this.sync, required this.api});

  final CartNotifier cart;
  final LocalStore store;
  final SyncService sync;
  final ApiClient api;

  @override
  State<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends State<CheckoutScreen> {
  String _method = 'cash';
  bool _busy = false;

  String _cents(int c) => '\$${(c / 100).toStringAsFixed(2)}';

  Future<void> _confirm() async {
    if (_busy) return;
    setState(() => _busy = true);

    final total = widget.cart.totalCents;
    final sale = PendingSale(
      id: uuidV4(),
      totalCents: total,
      subtotalCents: total,
      taxCents: 0,
      paymentMethod: _method,
      createdAt: DateTime.now().toIso8601String(),
      lines: widget.cart.items.map((i) {
        final l = i.saleLine;
        return SaleLine(productId: l.productId, productName: l.productName, priceCents: l.priceCents, qty: i.qty);
      }).toList(),
    );

    // 1) Durability first: persist before any network activity.
    await widget.store.addSale(sale);
    // 2) Best-effort immediate push. On failure the sale stays queued and the
    //    background worker will retry it.
    final result = await widget.sync.syncNow();
    widget.cart.clear();

    if (!mounted) return;
    setState(() => _busy = false);
    final ok = result.error == null && result.failures.isEmpty;
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        icon: Icon(ok ? Icons.check_circle : Icons.cloud_off,
            color: ok ? Colors.green : Colors.orange),
        title: Text(ok ? 'Sale recorded' : 'Saved offline'),
        content: Text(ok && result.synced.isNotEmpty
            ? 'Receipt synced to the ERP.'
            : 'The sale is saved on this device and will sync when a connection is available.${result.error != null ? '\n\n${result.error}' : ''}'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Done')),
        ],
      ),
    );
    if (mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final items = widget.cart.items;
    return Scaffold(
      appBar: AppBar(title: const Text('Checkout')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          ...items.map((i) => Card(
                child: ListTile(
                  title: Text(i.saleLine.productName),
                  subtitle: Text('${_cents(i.saleLine.priceCents)} x ${i.qty}'),
                  trailing: Text(_cents(i.lineTotalCents), style: const TextStyle(fontWeight: FontWeight.w600)),
                ),
              )),
          const Divider(),
          ListTile(
            leading: const Icon(Icons.receipt_long),
            title: const Text('Total'),
            trailing: Text(_cents(widget.cart.totalCents), style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
          ),
          const SizedBox(height: 8),
          Text('Payment', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 4),
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'cash', label: Text('Cash'), icon: Icon(Icons.payments)),
              ButtonSegment(value: 'card', label: Text('Card'), icon: Icon(Icons.credit_card)),
              ButtonSegment(value: 'mobile', label: Text('Mobile'), icon: Icon(Icons.phone_android)),
            ],
            selected: {_method},
            onSelectionChanged: (s) => setState(() => _method = s.first),
          ),
          const SizedBox(height: 24),
          FilledButton(
            onPressed: _busy ? null : _confirm,
            child: _busy
                ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                : Text('Confirm & Save  ${_cents(widget.cart.totalCents)}'),
          ),
          const SizedBox(height: 8),
          Text('Saved locally first, then synced to the ERP.',
              textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}