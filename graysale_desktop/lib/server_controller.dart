import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import 'child_process_job.dart';
import 'server_paths.dart';

/// How far the local server startup got.
enum ServerPhase { idle, probing, spawning, waiting, ready, missingBundle, failed }

/// Why startup failed.
enum ServerFailure { missingBundle, spawnError, timeout, exited }

@immutable
class ServerStartResult {
  const ServerStartResult._(this.ok, this.adopted, this.failure, this.message);

  const ServerStartResult.ready({required bool adopted})
      : this._(true, adopted, null, null);

  const ServerStartResult.failed(ServerFailure failure, String message)
      : this._(false, false, failure, message);

  final bool ok;

  /// True when an already-running server was detected and reused instead of
  /// spawned — this instance must never kill it.
  final bool adopted;
  final ServerFailure? failure;
  final String? message;
}

/// Owns the local GraySale Node server: adopt-if-running, spawn, health-poll,
/// log capture and teardown.
class ServerController extends ChangeNotifier {
  static const int pollSeconds = 60;
  static const int _maxLogLines = 500;

  ServerController() : port = ServerPaths.port;

  final int port;

  Process? _process;
  bool _adopted = false;
  bool _exited = false;
  int? _exitCode;
  final ChildProcessJob _job = ChildProcessJob();
  IOSink? _logSink;
  final ListQueue<String> _logLines = ListQueue<String>();

  /// Latest human-readable startup status, mirrored in [statusMessage].
  ServerPhase phase = ServerPhase.idle;
  String statusMessage = '';

  /// Bumped on every captured log line so views can rebuild their log tail.
  int logVersion = 0;

  bool get running => !_exited && (_adopted || _process != null);
  bool get adopted => _adopted;

  /// Last [count] captured log lines, newest last.
  String logTail({int count = 150}) {
    final lines = _logLines.toList();
    final start = lines.length > count ? lines.length - count : 0;
    return lines.sublist(start).join('\n');
  }

  /// Probes `GET /api/v1/health` once; true only when the JSON body says
  /// `{"ok": true}`.
  Future<bool> probeHealth() async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 2);
    try {
      final request = await client
          .getUrl(Uri.parse(ServerPaths.healthUrl))
          .timeout(const Duration(seconds: 3));
      final response = await request.close().timeout(const Duration(seconds: 3));
      final body = await response
          .transform(const Utf8Decoder(allowMalformed: true))
          .join()
          .timeout(const Duration(seconds: 3));
      if (response.statusCode != 200) return false;
      final decoded = jsonDecode(body);
      return decoded is Map && decoded['ok'] == true;
    } catch (_) {
      return false;
    } finally {
      client.close(force: true);
    }
  }

  /// Adopt a healthy running server or spawn the bundled one, then poll
  /// health for up to 60 seconds.
  Future<ServerStartResult> start() async {
    _exited = false;
    _exitCode = null;
    _setStatus(ServerPhase.probing,
        'Checking for an existing GraySale server on port $port…');

    if (await probeHealth()) {
      _adopted = true;
      _setStatus(ServerPhase.ready, 'Adopted running server on port $port.');
      return const ServerStartResult.ready(adopted: true);
    }

    if (!ServerPaths.bundlePresent) {
      _setStatus(ServerPhase.missingBundle, 'Server bundle not found.');
      return const ServerStartResult.failed(
        ServerFailure.missingBundle,
        'The bundled GraySale server was not found next to this application.',
      );
    }

    Directory(ServerPaths.appHome).createSync(recursive: true);
    Directory(ServerPaths.dataDir).createSync(recursive: true);

    _setStatus(ServerPhase.spawning, 'Starting local server process…');
    Process process;
    try {
      process = await Process.start(
        ServerPaths.nodeExe,
        [ServerPaths.serverJs],
        workingDirectory: ServerPaths.serverWorkingDir,
        environment: <String, String>{
          'NODE_ENV': 'production',
          'GRAYSTORAGE_ROOT': ServerPaths.dataDir,
          'PORT': '$port',
        },
      );
    } catch (e) {
      final message = 'Could not start ${ServerPaths.nodeExe}: $e';
      _appendLog(message);
      return ServerStartResult.failed(ServerFailure.spawnError, message);
    }

    _process = process;
    _job.attach(process.pid);

    _logSink = File(ServerPaths.logFile).openWrite(mode: FileMode.append);
    _appendLog('--- graysale_desktop launched ${DateTime.now().toIso8601String()} '
        '(port $port, pid ${process.pid}) ---');
    const decoder = Utf8Decoder(allowMalformed: true);
    process.stdout
        .transform(decoder)
        .transform(const LineSplitter())
        .listen(_appendLog);
    process.stderr
        .transform(decoder)
        .transform(const LineSplitter())
        .listen(_appendLog);
    process.exitCode.then((code) {
      _exited = true;
      _exitCode = code;
      _appendLog('--- server process exited with code $code ---');
    });

    _setStatus(ServerPhase.waiting, 'Waiting for the server to answer on port $port…');
    for (var i = 1; i <= pollSeconds; i++) {
      await Future<void>.delayed(const Duration(seconds: 1));
      if (await probeHealth()) {
        _setStatus(ServerPhase.ready, 'Server running on port $port.');
        return const ServerStartResult.ready(adopted: false);
      }
      if (_exited) {
        return ServerStartResult.failed(
          ServerFailure.exited,
          'The server process exited with code $_exitCode before it became healthy.',
        );
      }
      _setStatus(ServerPhase.waiting,
          'Waiting for the server to answer on port $port… (${i}s)');
    }
    return const ServerStartResult.failed(
      ServerFailure.timeout,
      'The server did not answer within $pollSeconds seconds.',
    );
  }

  /// Kills the spawned process tree (never an adopted one). The job object
  /// guarantees the same outcome if the app dies without reaching this.
  Future<void> stop() async {
    final process = _process;
    if (process != null && !_adopted) {
      try {
        await Process.run(
          'taskkill',
          <String>['/PID', '${process.pid}', '/T', '/F'],
        );
      } catch (_) {
        // Best effort — the job object is the hard guarantee.
      }
    }
    _process = null;
    await _logSink?.flush();
    await _logSink?.close();
    _logSink = null;
    _job.dispose();
  }

  void _setStatus(ServerPhase newPhase, String message) {
    phase = newPhase;
    statusMessage = message;
    notifyListeners();
  }

  void _appendLog(String line) {
    if (_logLines.length >= _maxLogLines) _logLines.removeFirst();
    _logLines.addLast(line);
    _logSink?.writeln(line);
    logVersion++;
    notifyListeners();
  }
}
