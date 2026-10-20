import 'dart:io';

/// Resolves every filesystem/network location the desktop host needs.
///
/// Ship layout (next to graysale_desktop.exe):
///
///   graysale_desktop.exe
///   GraySaleServer\
///     node\node.exe
///     app\src\server.js
///     app\web\dist\...
class ServerPaths {
  ServerPaths._();

  static String join(List<String> parts) =>
      parts.where((p) => p.isNotEmpty).join(Platform.pathSeparator);

  /// Folder containing the running executable.
  static String get exeDir =>
      File(Platform.resolvedExecutable).parent.path;

  /// Root of the bundled server. `GRAYSALE_SERVER_DIR` overrides the default
  /// `<exeDir>\GraySaleServer` location.
  static String get serverRoot {
    final override = Platform.environment['GRAYSALE_SERVER_DIR'];
    if (override != null && override.trim().isNotEmpty) {
      return override.trim();
    }
    return join([exeDir, 'GraySaleServer']);
  }

  /// `%LOCALAPPDATA%\GraySale` — holds data\ and server.log.
  static String get appHome {
    final localAppData = Platform.environment['LOCALAPPDATA'];
    final base = (localAppData != null && localAppData.isNotEmpty)
        ? localAppData
        : exeDir;
    return join([base, 'GraySale']);
  }

  static String get dataDir => join([appHome, 'data']);
  static String get logFile => join([appHome, 'server.log']);

  /// Port the local server is expected to answer on. `GRAYSALE_PORT`
  /// overrides the default 3030.
  static int get port {
    final raw = Platform.environment['GRAYSALE_PORT'];
    if (raw != null) {
      final parsed = int.tryParse(raw.trim());
      if (parsed != null && parsed >= 1 && parsed <= 65535) return parsed;
    }
    return 3030;
  }

  static String get nodeExe => join([serverRoot, 'node', 'node.exe']);
  static String get serverJs => join([serverRoot, 'app', 'src', 'server.js']);
  static String get serverWorkingDir => join([serverRoot, 'app']);

  static String get healthUrl => 'http://127.0.0.1:$port/api/v1/health';
  static String get appUrl => 'http://localhost:$port/';

  /// True when the essential server bundle is present.
  static bool get bundlePresent =>
      Directory(serverRoot).existsSync() &&
      File(nodeExe).existsSync() &&
      File(serverJs).existsSync();
}
