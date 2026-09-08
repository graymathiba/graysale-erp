import 'package:flutter_test/flutter_test.dart';
import 'package:pos_app/models/sale.dart';
import 'package:pos_app/services/api_client.dart';
import 'package:pos_app/services/local_store.dart';
import 'package:pos_app/services/sync_service.dart';

/// In-memory LocalStore for tests.
class FakeLocalStore implements LocalStore {
  final Map<String, PendingSale> _rows = {};
  final Set<String> synced = {};

  @override
  Future<void> addSale(PendingSale sale) async {
    _rows[sale.id] = sale;
  }

  @override
  Future<int> countPending() async => _rows.values.where((s) => !synced.contains(s.id)).length;

  @override
  Future<void> markSynced(String id) async => synced.add(id);

  @override
  Future<List<PendingSale>> pendingSales() async => _rows.values.where((s) => !synced.contains(s.id)).toList();
}

/// ApiClient subclass that fakes the network layer.
class FakeApi extends ApiClient {
  FakeApi({this.onSync, this.onError}) : super(baseUrl: 'http://test');

  /// Called with the source payload; return the sync result to simulate.
  final Future<SyncSalesResult> Function(List<Map<String, dynamic>> payload)? onSync;
  final ApiException? onError;
  final List<List<Map<String, dynamic>>> calls = [];

  @override
  Future<SyncSalesResult> syncSales(List<Map<String, dynamic>> sales) async {
    calls.add(sales);
    if (onError != null) throw onError!;
    return onSync != null ? onSync!(sales) : const SyncSalesResult(success: true);
  }
}

PendingSale sale(String id, int total) => PendingSale(
      id: id,
      totalCents: total,
      paymentMethod: 'cash',
      createdAt: '2026-09-08T10:00:00.000Z',
      lines: [SaleLine(productId: 1, productName: 'Milk', priceCents: total, qty: 1)],
    );

void main() {
  test('syncNow pushes pending sales and marks acked ids synced', () async {
    final store = FakeLocalStore();
    final a = sale('a1', 100);
    final b = sale('b2', 200);
    await store.addSale(a);
    await store.addSale(b);

    final api = FakeApi(onSync: (payload) async {
      expect(payload.map((p) => p['id']), containsAll(['a1', 'b2']));
      return const SyncSalesResult(success: true, syncedIds: ['a1', 'b2']);
    });
    final result = await SyncService(api: api, store: store).syncNow();

    expect(result.ok, isTrue);
    expect(result.synced, ['a1', 'b2']);
    expect(store.synced, containsAll(['a1', 'b2']));
    expect(await store.countPending(), 0);
    expect(api.calls, hasLength(1));
  });

  test('syncNow with nothing pending is a no-op (no network call)', () async {
    final store = FakeLocalStore();
    final api = FakeApi();
    final result = await SyncService(api: api, store: store).syncNow();
    expect(result.ok, isTrue);
    expect(api.calls, isEmpty);
  });

  test('syncNow on network failure leaves sales queued', () async {
    final store = FakeLocalStore();
    await store.addSale(sale('a1', 100));
    final api = FakeApi(onError: ApiException('connection refused'));
    final result = await SyncService(api: api, store: store).syncNow();
    expect(result.ok, isFalse);
    expect(result.error, contains('connection refused'));
    expect(store.synced, isEmpty);
    expect(await store.countPending(), 1);
  });

  test('duplicates reported by server are marked synced', () async {
    final store = FakeLocalStore();
    await store.addSale(sale('a1', 100));
    final api = FakeApi(onSync: (payload) async {
      return const SyncSalesResult(success: true, duplicates: ['a1']);
    });
    final result = await SyncService(api: api, store: store).syncNow();
    expect(result.ok, isTrue);
    expect(store.synced, contains('a1'));
    expect(result.duplicates, ['a1']);
  });

  test('unacknowledged sales are reported as failures and stay queued', () async {
    final store = FakeLocalStore();
    await store.addSale(sale('a1', 100));
    await store.addSale(sale('b2', 200));
    final api = FakeApi(onSync: (payload) async {
      return const SyncSalesResult(success: true, syncedIds: ['a1']);
    });
    final result = await SyncService(api: api, store: store).syncNow();
    expect(result.ok, isFalse);
    expect(result.failures, ['b2']);
    expect(store.synced, contains('a1'));
    expect(await store.countPending(), 1);
  });

  test('pendingSales round-trip stores the full line info', () async {
    final store = FakeLocalStore();
    await store.addSale(sale('a1', 100));
    final pending = await store.pendingSales();
    expect(pending.single.lines.single.productName, 'Milk');
  });
}