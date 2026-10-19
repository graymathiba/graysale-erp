/// App-level configuration.
///
/// Override the backend URL at build time:
///   flutter run --dart-define=API_BASE_URL=http://192.168.1.50:3030
///
/// Default targets the Android emulator loopback (10.0.2.2 maps to the host)
/// on the GraySale server's default port (3030).
class AppConfig {
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://10.0.2.2:3030',
  );
}