// Minimal token persistence abstraction so the app and the background sync
// isolate can share auth without importing shared_preferences everywhere.

abstract class TokenStore {
  Future<String?> read();
  Future<void> write(String? token);
  Future<void> clear();
}