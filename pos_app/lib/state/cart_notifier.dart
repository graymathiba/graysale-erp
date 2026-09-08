import 'package:flutter/foundation.dart';

import '../models/sale.dart';

class CartItem {
  CartItem(this.saleLine, this.qty);
  final SaleLine saleLine;
  num qty;

  int get lineTotalCents => (saleLine.priceCents * qty).round();
}

/// POS shopping cart. Pure Dart — no widgets — so it is unit-testable.
class CartNotifier extends ChangeNotifier {
  final Map<int, CartItem> _items = {};

  List<CartItem> get items => _items.values.toList();
  bool get isEmpty => _items.isEmpty;

  int get totalCents => _items.values.fold(0, (sum, i) => sum + i.lineTotalCents);
  int get itemCount => _items.values.fold<num>(0, (sum, i) => sum + i.qty).round();

  void add(int productId, String name, int priceCents, {num qty = 1}) {
    final existing = _items[productId];
    if (existing != null) {
      existing.qty += qty;
    } else {
      _items[productId] = CartItem(
        SaleLine(productId: productId, productName: name, priceCents: priceCents, qty: qty),
        qty,
      );
    }
    notifyListeners();
  }

  void setQty(int productId, num qty) {
    final item = _items[productId];
    if (item == null) return;
    if (qty <= 0) {
      _items.remove(productId);
    } else {
      item.qty = qty;
    }
    notifyListeners();
  }

  void clear() {
    _items.clear();
    notifyListeners();
  }
}