import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../services/local_store.dart';
import '../services/sync_service.dart';
import '../state/cart_notifier.dart';
import 'checkout_screen.dart';

class PosHomeScreen extends StatefulWidget {
  const PosHomeScreen({super.key, required this.api, required this.store, required this.cart, required this.sync});

  final ApiClient api;
  final LocalStore store;
  final CartNotifier cart;
  final SyncService sync;

  @override
  State<PosHomeScreen> createState() => _PosHomeScreenState();
}

class _PosHomeScreenState extends State<PosHomeScreen> {
  List<Map<String, dynamic>> _products = [];
  bool _loading = true;
  String? _catalogError;
  int _pendingCount = 0;
  bool _syncing = false;

  @override
  void initState() {
    super.initState();
    _refreshPending();
    _loadProducts();
  }

  Future<void> _refreshPending() async {
    final n = await widget.store.countPending();
    if (mounted) setState(() => _pendingCount = n);
  }

  Future<void> _loadProducts() async {
    setState(() { _loading = true; _catalogError = null; });
    try {
      final products = await widget.api.fetchProducts();
      if (!mounted) return;
      setState(() { _products = products; _loading = false; });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() { _catalogError = e.message; _loading = false; });
    }
  }

  Future<void> _manualSync() async {
    if (_syncing) return;
    setState(() => _syncing = true);
    final result = await widget.sync.syncNow();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(
        result.error != null
            ? 'Sync: ${result.error}'
            : 'Synced ${result.synced.length} sale(s), ${result.duplicates.length} already synced.',
      )),
    );
    setState(() => _syncing = false);
    await _refreshPending();
  }

  String _cents(int c) {
    final v = (c / 100).toStringAsFixed(2);
    return '\$$v';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Graysale POS'),
        actions: [
          IconButton(
            tooltip: _pendingCount > 0 ? '$_pendingCount sale(s) awaiting sync' : 'Sync',
            icon: _syncing
                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                : Badge(isLabelVisible: _pendingCount > 0, label: Text('$_pendingCount'), child: const Icon(Icons.sync)),
            onPressed: _manualSync,
          ),
          IconButton(
            tooltip: 'Sign out',
            icon: const Icon(Icons.logout),
            onPressed: () async {
              await widget.api.logout();
              if (!context.mounted) return;
              Navigator.of(context).pushNamedAndRemoveUntil('/login', (r) => false);
            },
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(child: _buildCatalog()),
          _buildCartBar(),
        ],
      ),
    );
  }

  Widget _buildCatalog() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_catalogError != null) {
      return Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.cloud_off, size: 48, color: Colors.grey),
          const SizedBox(height: 8),
          const Text('Offline — could not load catalog'),
          const SizedBox(height: 4),
          Text(_catalogError!, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 8),
          OutlinedButton.icon(onPressed: _loadProducts, icon: const Icon(Icons.refresh), label: const Text('Retry')),
        ]),
      );
    }
    if (_products.isEmpty) {
      return const Center(child: Text('No products yet'));
    }
    return GridView.builder(
      padding: const EdgeInsets.all(12),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 220,
        mainAxisSpacing: 10,
        crossAxisSpacing: 10,
        childAspectRatio: 1.35,
      ),
      itemCount: _products.length,
      itemBuilder: (context, i) {
        final p = _products[i];
        final id = int.parse('${p['id']}');
        final name = p['name']?.toString() ?? 'Product';
        final price = int.parse('${p['price_cents'] ?? 0}');
        return Card(
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: () => _addToCart(id, name, price),
            child: Padding(
              padding: const EdgeInsets.all(10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(name, maxLines: 2, overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleSmall),
                  const Spacer(),
                  Row(children: [
                    Text(_cents(price), style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
                    const Spacer(),
                    const Icon(Icons.add_circle, color: Colors.indigo),
                  ]),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  void _addToCart(int id, String name, int price) {
    widget.cart.add(id, name, price);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text('Added $name'),
      duration: const Duration(milliseconds: 600),
    ));
  }

  Widget _buildCartBar() {
    return AnimatedBuilder(
      animation: widget.cart,
      builder: (context, _) {
        if (widget.cart.isEmpty) {
          return const SafeArea(child: SizedBox(height: 8));
        }
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
            child: Material(
              elevation: 4,
              borderRadius: BorderRadius.circular(12),
              color: Theme.of(context).colorScheme.primaryContainer,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                  child: Row(
                    children: [
                      Icon(Icons.shopping_cart, color: Theme.of(context).colorScheme.onPrimaryContainer),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          widget.cart.items.map((i) => '${i.saleLine.productName} x${i.qty}').join(', '),
                          maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodyMedium,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text('${widget.cart.itemCount} item(s)', style: Theme.of(context).textTheme.bodyMedium),
                      const SizedBox(width: 12),
                      Text(_cents(widget.cart.totalCents), style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
                      const SizedBox(width: 8),
                      FilledButton(
                        onPressed: () async {
                          await Navigator.of(context).push(MaterialPageRoute(
                            builder: (_) => CheckoutScreen(cart: widget.cart, store: widget.store, sync: widget.sync, api: widget.api),
                          ));
                          await _refreshPending();
                        },
                        child: const Text('Checkout'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}