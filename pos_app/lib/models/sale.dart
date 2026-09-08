// Offline-first sale models.
//
// A [PendingSale] is the unit the POS writes to the local SQLite store at
// checkout time and later pushes to the ERP via `/api/v1/sync/sales`. The
// `id` is a client-generated UUID that acts as the idempotency key server
// side, so re-sending a sale after a network drop never creates a duplicate
// receipt.

class SaleLine {
  SaleLine({
    required this.productId,
    required this.productName,
    required this.priceCents,
    required this.qty,
  });

  final int productId;
  final String productName;
  final int priceCents;
  final num qty;

  int get lineTotalCents => (priceCents * qty).round();

  Map<String, dynamic> toJson() => {
        'product_id': productId,
        'product_name': productName,
        'price_cents': priceCents,
        'qty': qty,
      };

  factory SaleLine.fromJson(Map<String, dynamic> json) => SaleLine(
        productId: int.parse(json['product_id'].toString()),
        productName: json['product_name']?.toString() ?? '',
        priceCents: int.parse(json['price_cents'].toString()),
        qty: num.parse(json['qty'].toString()),
      );
}

class PendingSale {
  PendingSale({
    required this.id,
    required this.totalCents,
    required this.paymentMethod,
    required this.createdAt,
    this.subtotalCents,
    this.taxCents,
    this.lines = const [],
  });

  /// Client-generated idempotency key (UUID). Stable across retries.
  final String id;
  final int totalCents;
  final String paymentMethod;
  final String createdAt;
  final int? subtotalCents;
  final int? taxCents;
  final List<SaleLine> lines;

  Map<String, dynamic> toSyncJson() => {
        'id': id,
        'total_cents': totalCents,
        'subtotal_cents': subtotalCents ?? totalCents,
        'tax_cents': taxCents ?? 0,
        'payment_method': paymentMethod,
        'created_at': createdAt,
        'lines': lines.map((l) => l.toJson()).toList(),
      };

  Map<String, dynamic> toRowJson() => {
        'id': id,
        'total_cents': totalCents,
        'payment_method': paymentMethod,
        'created_at': createdAt,
        'lines': lines.map((l) => l.toJson()).toList(),
      };
}