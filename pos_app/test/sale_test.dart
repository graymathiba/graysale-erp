import 'package:flutter_test/flutter_test.dart';
import 'package:pos_app/models/sale.dart';
import 'package:pos_app/state/cart_notifier.dart';
import 'package:pos_app/util/uuid.dart';

void main() {
  group('SaleLine', () {
    test('computes line totals', () {
      final line = SaleLine(productId: 1, productName: 'Milk', priceCents: 250, qty: 3);
      expect(line.lineTotalCents, 750);
    });

    test('round-trips through JSON', () {
      final line = SaleLine(productId: 7, productName: 'Bread', priceCents: 180, qty: 2.5);
      final back = SaleLine.fromJson(line.toJson());
      expect(back.productId, 7);
      expect(back.qty, 2.5);
      expect(back.priceCents, 180);
    });
  });

  group('PendingSale', () {
    test('sync payload includes idempotency id and camel/snake keys', () {
      final sale = PendingSale(
        id: 'abc-123',
        totalCents: 1000,
        paymentMethod: 'cash',
        createdAt: '2026-09-08T10:00:00.000Z',
        lines: [SaleLine(productId: 1, productName: 'Milk', priceCents: 250, qty: 2)],
      );
      final json = sale.toSyncJson();
      expect(json['id'], 'abc-123');
      expect(json['total_cents'], 1000);
      expect(json['payment_method'], 'cash');
      expect(json['lines'], hasLength(1));
    });
  });

  group('CartNotifier', () {
    test('adds and aggregates quantities', () {
      final cart = CartNotifier();
      cart.add(1, 'Milk', 250);
      cart.add(1, 'Milk', 250, qty: 2);
      expect(cart.itemCount, 3);
      expect(cart.totalCents, 750);
      expect(cart.items, hasLength(1));
    });

    test('setQty removes at zero', () {
      final cart = CartNotifier();
      cart.add(1, 'Milk', 250);
      cart.setQty(1, 0);
      expect(cart.isEmpty, isTrue);
    });

    test('clear empties cart', () {
      final cart = CartNotifier();
      cart.add(1, 'Milk', 250);
      cart.add(2, 'Bread', 180);
      cart.clear();
      expect(cart.isEmpty, isTrue);
      expect(cart.totalCents, 0);
    });
  });

  group('uuidV4', () {
    test('is unique and well-formed', () {
      final a = uuidV4();
      final b = uuidV4();
      expect(a, isNot(b));
      expect(a, matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')));
    });
  });
}