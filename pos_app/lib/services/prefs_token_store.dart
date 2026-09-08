import 'package:shared_preferences/shared_preferences.dart';

import 'token_store.dart';

/// SharedPreferences-backed token store, usable both in-app and in the
/// background sync isolate.
class PrefsTokenStore implements TokenStore {
  static const _key = 'auth_token';

  @override
  Future<String?> read() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_key);
  }

  @override
  Future<void> write(String? token) async {
    final prefs = await SharedPreferences.getInstance();
    if (token == null) {
      await prefs.remove(_key);
    } else {
      await prefs.setString(_key, token);
    }
  }

  @override
  Future<void> clear() => write(null);
}