import 'package:dio/dio.dart';

import '../config.dart';
import 'token_store.dart';

/// Result of `POST /api/v1/auth/login` as returned by the ERP server.
class LoginResult {
  const LoginResult({required this.ok, this.token, this.user, this.error});

  final bool ok;
  final String? token;
  final Map<String, dynamic>? user;
  final String? error;
}

/// Result of `POST /api/v1/sync/sales`.
class SyncSalesResult {
  const SyncSalesResult({this.success = false, this.syncedIds = const [], this.duplicates = const []});

  final bool success;
  final List<String> syncedIds;
  final List<String> duplicates;
}

class ApiException implements Exception {
  ApiException(this.message, {this.statusCode});
  final String message;
  final int? statusCode;
  @override
  String toString() => message;
}

/// Thin REST client for the ERP `/api/v1/*` endpoints the POS relies on.
class ApiClient {
  late final Dio _dio;
  late final TokenStore? _tokenStore;

  ApiClient({String? baseUrl, TokenStore? tokenStore, Dio? dio}) {
    _dio = dio ??
        Dio(BaseOptions(
          baseUrl: baseUrl ?? AppConfig.apiBaseUrl,
          connectTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 20),
        ));
    _tokenStore = tokenStore;
  }

  String? _token;
  String? get token => _token;

  Future<String?> loadToken() async {
    _token = await _tokenStore?.read();
    return _token;
  }

  Options get _authOptions => Options(
        headers: {if (_token != null) 'Authorization': 'Bearer $_token'},
      );

  Future<LoginResult> login(String username, String password) async {
    try {
      final res = await _dio.post(
        '/api/v1/auth/login',
        data: {'username': username, 'password': password},
      );
      final data = (res.data as Map?) ?? const {};
      final ok = data['ok'] == true;
      if (ok) {
        _token = data['token'] as String?;
        await _tokenStore?.write(_token);
      }
      return LoginResult(
        ok: ok,
        token: _token,
        user: data['user'] as Map<String, dynamic>?,
        error: data['error'] as String?,
      );
    } on DioException catch (e) {
      final data = e.response?.data as Map?;
      throw ApiException(
        data?['error']?.toString() ?? 'Could not reach the server (${e.message})',
        statusCode: e.response?.statusCode,
      );
    }
  }

  Future<List<Map<String, dynamic>>> fetchProducts({String? search}) async {
    try {
      final res = await _dio.get(
        '/api/v1/products',
        queryParameters: {if (search != null && search.isNotEmpty) 'search': search},
        options: _authOptions,
      );
      final data = res.data;
      return switch (data) {
        List<dynamic> list => list.map((e) => (e as Map).cast<String, dynamic>()).toList(),
        Map<String, dynamic> m => ((m['data'] ?? m['results']) as List? ?? const [])
            .map((e) => (e as Map).cast<String, dynamic>())
            .toList(),
        _ => const [],
      };
    } on DioException catch (e) {
      throw ApiException('Could not load products (${e.message})', statusCode: e.response?.statusCode);
    }
  }

  /// Pushes queued offline sales. Idempotent server-side by local sale id.
  Future<SyncSalesResult> syncSales(List<Map<String, dynamic>> sales) async {
    if (sales.isEmpty) return const SyncSalesResult(success: true);
    try {
      final res = await _dio.post(
        '/api/v1/sync/sales',
        data: {'sales': sales},
        options: _authOptions,
      );
      final data = (res.data as Map?) ?? const {};
      return SyncSalesResult(
        success: data['success'] == true,
        syncedIds: (data['syncedIds'] as List? ?? const []).map((e) => e.toString()).toList(),
        duplicates: (data['duplicates'] as List? ?? const []).map((e) => e.toString()).toList(),
      );
    } on DioException catch (e) {
      throw ApiException('Sync failed (${e.message})', statusCode: e.response?.statusCode);
    }
  }

  Future<void> logout() async {
    try {
      await _dio.post('/api/v1/auth/logout', options: _authOptions);
    } on DioException {
      // Best effort — clearing the local token is what matters.
    }
    _token = null;
    await _tokenStore?.clear();
  }
}