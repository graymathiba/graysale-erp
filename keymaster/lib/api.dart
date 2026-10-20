// Typed HTTP client for the GraySale Control Tower super-admin API.
// All non-2xx responses throw ApiException carrying the server's error text;
// a 401 on any authenticated call raises the session-expired signal.

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

class ApiException implements Exception {
  ApiException(this.message, {this.statusCode, this.sessionExpired = false});

  final String message;
  final int? statusCode;
  final bool sessionExpired;

  @override
  String toString() => message;
}

class LoginResult {
  const LoginResult({required this.token, required this.user});

  final String token;
  final Map<String, dynamic> user;

  bool get isSuperAdmin => user['isSuperAdmin'] == true;
}

class GeneratedKey {
  const GeneratedKey({required this.keyCode, required this.planType});

  final String keyCode;
  final String planType;
}

class ConnectedResult {
  const ConnectedResult({
    required this.windowMs,
    required this.checkedAt,
    required this.tenants,
  });

  final int windowMs;
  final DateTime? checkedAt;
  final List<Map<String, dynamic>> tenants;

  factory ConnectedResult.fromJson(Map<String, dynamic> data) {
    return ConnectedResult(
      windowMs: (data['windowMs'] as num?)?.toInt() ?? 5 * 60 * 1000,
      checkedAt: DateTime.tryParse(data['checkedAt']?.toString() ?? ''),
      tenants: (data['tenants'] as List? ?? const [])
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList(),
    );
  }
}

class ApiClient {
  ApiClient(this.baseUrl);

  String baseUrl;
  String? token;

  static const _timeout = Duration(seconds: 15);

  Uri _uri(String path, [Map<String, String>? query]) {
    var base = baseUrl.trim();
    while (base.endsWith('/')) {
      base = base.substring(0, base.length - 1);
    }
    final root = base.contains('/api/v1') ? base : '$base/api/v1';
    final params = <String, String>{...?query}
      ..removeWhere((_, v) => v.isEmpty);
    return Uri.parse(
      '$root$path',
    ).replace(queryParameters: params.isEmpty ? null : params);
  }

  String _friendly(Object? raw, int status) {
    final code = raw?.toString() ?? '';
    switch (code) {
      case 'INVALID_CREDENTIALS':
        return 'Invalid username or password';
      case 'RATE_LIMITED':
        return 'Too many failed attempts — try again shortly';
      case 'UNAUTHORIZED':
        return 'Unauthorized';
      case 'FORBIDDEN':
        return 'This account does not have super-admin access';
      case 'TENANT_NOT_FOUND':
        return 'Tenant not found';
      case 'KEY_NOT_FOUND':
        return 'Key not found';
      case 'INVALID_PLAN_TYPE':
        return 'Invalid plan type';
      case 'INVALID_COUNT':
        return 'Count must be between 1 and 500';
      case 'INVALID_DAYS':
        return 'Enter a positive number of days';
      default:
        return code.isEmpty ? 'Request failed (HTTP $status)' : code;
    }
  }

  Future<dynamic> _send(
    String method,
    String path, {
    Map<String, String>? query,
    Object? body,
    bool auth = true,
  }) async {
    final request = http.Request(method, _uri(path, query));
    request.headers['Content-Type'] = 'application/json';
    if (auth && token != null) {
      request.headers['Authorization'] = 'Bearer $token';
    }
    if (body != null) request.body = jsonEncode(body);

    http.StreamedResponse res;
    try {
      res = await http.Client().send(request).timeout(_timeout);
    } on TimeoutException {
      throw ApiException('Server at $baseUrl did not respond (timeout)');
    } catch (_) {
      throw ApiException('Cannot reach server at $baseUrl');
    }

    final text = await res.stream.bytesToString();
    dynamic data;
    try {
      data = text.isEmpty ? null : jsonDecode(text);
    } catch (_) {
      data = null;
    }

    final status = res.statusCode;
    if (status >= 200 && status < 300) return data;

    final map = data is Map
        ? Map<String, dynamic>.from(data)
        : const <String, dynamic>{};
    final raw = map['error'] ?? map['message'];
    throw ApiException(
      _friendly(raw, status),
      statusCode: status,
      sessionExpired: status == 401 && path != '/auth/login',
    );
  }

  List<Map<String, dynamic>> _mapList(dynamic data) {
    if (data is! List) return const [];
    return data
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
  }

  Future<LoginResult> login(String username, String password) async {
    final data = await _send(
      'POST',
      '/auth/login',
      body: {'username': username, 'password': password},
      auth: false,
    );
    final map = data is Map
        ? Map<String, dynamic>.from(data)
        : <String, dynamic>{};
    if (map['ok'] != true || map['token'] == null) {
      throw ApiException(_friendly(map['error'], 401), statusCode: 401);
    }
    token = map['token'] as String;
    return LoginResult(
      token: token!,
      user: map['user'] is Map
          ? Map<String, dynamic>.from(map['user'] as Map)
          : <String, dynamic>{},
    );
  }

  Future<Map<String, dynamic>> overview() async {
    final data = await _send('GET', '/superadmin/overview');
    return data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};
  }

  Future<List<Map<String, dynamic>>> listKeys({
    String? status,
    String? search,
  }) async {
    final data = await _send(
      'GET',
      '/superadmin/keys',
      query: {
        if (status != null && status.isNotEmpty) 'status': status,
        if (search != null && search.isNotEmpty) 'search': search,
      },
    );
    return _mapList(data);
  }

  Future<List<GeneratedKey>> generateKeys({
    required String planType,
    int count = 1,
  }) async {
    final data = await _send(
      'POST',
      '/superadmin/keys/generate',
      body: {'planType': planType, 'count': count},
    );
    final map = data is Map
        ? Map<String, dynamic>.from(data)
        : <String, dynamic>{};
    return (map['keys'] as List? ?? const [])
        .whereType<Map>()
        .map(
          (k) => GeneratedKey(
            keyCode: k['keyCode']?.toString() ?? '-',
            planType: k['planType']?.toString() ?? planType,
          ),
        )
        .toList();
  }

  Future<List<Map<String, dynamic>>> listTenants({
    String? search,
    String? status,
  }) async {
    final data = await _send(
      'GET',
      '/superadmin/tenants',
      query: {
        if (search != null && search.isNotEmpty) 'search': search,
        if (status != null && status.isNotEmpty) 'status': status,
      },
    );
    return _mapList(data);
  }

  Future<Map<String, dynamic>> toggleTenant(String id) async {
    final data = await _send('POST', '/superadmin/tenants/$id/toggle');
    return data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};
  }

  Future<Map<String, dynamic>> extendTenant(String id, int days) async {
    final data = await _send(
      'POST',
      '/superadmin/tenants/$id/extend',
      body: {'days': days},
    );
    return data is Map ? Map<String, dynamic>.from(data) : <String, dynamic>{};
  }

  Future<ConnectedResult> connected({int? windowMs}) async {
    final data = await _send(
      'GET',
      '/superadmin/connected',
      query: {if (windowMs != null) 'windowMs': windowMs.toString()},
    );
    return data is Map
        ? ConnectedResult.fromJson(Map<String, dynamic>.from(data))
        : ConnectedResult(
            windowMs: 5 * 60 * 1000,
            checkedAt: null,
            tenants: const [],
          );
  }
}
