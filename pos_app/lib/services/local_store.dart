import 'dart:convert';

import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

import '../models/sale.dart';

/// Local persistence abstraction so the store is swappable in unit tests.
abstract class LocalStore {
  Future<List<PendingSale>> pendingSales();
  Future<int> countPending();
  Future<void> addSale(PendingSale sale);
  Future<void> markSynced(String id);
}

/// SQLite-backed offline queue. Runs on the device and inside the background
/// sync isolate.
class SqliteLocalStore implements LocalStore {
  SqliteLocalStore._(this._db);

  final Database _db;

  static const _dbName = 'pos_sales.db';
  static const _table = 'pending_sales';

  static Future<SqliteLocalStore> open({String? databasePath}) async {
    final path = databasePath ?? p.join(await getDatabasesPath(), _dbName);
    final db = await openDatabase(
      path,
      version: 1,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE $_table (
            id TEXT PRIMARY KEY,
            total_cents INTEGER NOT NULL,
            payment_method TEXT NOT NULL,
            created_at TEXT NOT NULL,
            lines_json TEXT NOT NULL,
            synced INTEGER NOT NULL DEFAULT 0
          )
        ''');
        await db.execute('CREATE INDEX idx_${_table}_synced ON $_table(synced)');
      },
    );
    return SqliteLocalStore._(db);
  }

  @override
  Future<void> addSale(PendingSale sale) async {
    await _db.insert(_table, {
      'id': sale.id,
      'total_cents': sale.totalCents,
      'payment_method': sale.paymentMethod,
      'created_at': sale.createdAt,
      'lines_json': jsonEncode(sale.lines.map((l) => l.toJson()).toList()),
      'synced': 0,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  @override
  Future<List<PendingSale>> pendingSales() async {
    final rows = await _db.query(
      _table,
      where: 'synced = 0',
      orderBy: 'created_at ASC',
    );
    return rows.map(_rowToSale).toList();
  }

  @override
  Future<int> countPending() async {
    final res = await _db.rawQuery('SELECT COUNT(*) AS c FROM $_table WHERE synced = 0');
    return (res.first['c'] as int?) ?? 0;
  }

  @override
  Future<void> markSynced(String id) async {
    await _db.update(_table, {'synced': 1}, where: 'id = ?', whereArgs: [id]);
  }

  PendingSale _rowToSale(Map<String, dynamic> row) {
    final lines = (row['lines_json'] as String? ?? '[]');
    return PendingSale(
      id: row['id'] as String,
      totalCents: (row['total_cents'] as int?) ?? 0,
      paymentMethod: (row['payment_method'] as String?) ?? 'cash',
      createdAt: (row['created_at'] as String?) ?? '',
      lines: _decodeLines(lines),
    );
  }

  static List<SaleLine> _decodeLines(String raw) {
    try {
      final list = jsonDecode(raw) as List;
      return list.map((e) => SaleLine.fromJson((e as Map).cast<String, dynamic>())).toList();
    } catch (_) {
      return const [];
    }
  }
}