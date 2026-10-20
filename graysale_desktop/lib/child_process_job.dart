import 'dart:ffi';

/// Ties the lifetime of spawned child processes to this app using a Win32
/// job object with `JOB_OBJECT_KILL_ON_JOB_CLOSE`.
///
/// Windows has no `pdeathsig`, and closing the Flutter window does not run any
/// Dart cleanup hook, so without this a spawned `node.exe` would survive the
/// app as an orphan holding the port. With the job object, killing or closing
/// the app (for any reason) makes the OS terminate the whole process tree.
///
/// Uses only `dart:ffi` against kernel32 — no plugin dependencies.
class ChildProcessJob {
  static DynamicLibrary? _kernel32;

  static DynamicLibrary get kernel32 =>
      _kernel32 ??= DynamicLibrary.open('kernel32.dll');

  late final Pointer<Void> Function(Pointer<Void>, Pointer<Void>)
      _createJobObjectW = kernel32.lookupFunction<
          Pointer<Void> Function(Pointer<Void>, Pointer<Void>),
          Pointer<Void> Function(Pointer<Void>, Pointer<Void>)>(
        'CreateJobObjectW',
      );

  late final Pointer<Void> Function(int, int, int) _openProcess = kernel32
      .lookupFunction<
          Pointer<Void> Function(Uint32, Int32, Uint32),
          Pointer<Void> Function(int, int, int)>('OpenProcess');

  late final int Function(Pointer<Void>, Pointer<Void>)
      _assignProcessToJobObject = kernel32.lookupFunction<
          Int32 Function(Pointer<Void>, Pointer<Void>),
          int Function(Pointer<Void>, Pointer<Void>)>(
        'AssignProcessToJobObject',
      );

  late final int Function(Pointer<Void>, int, Pointer<Void>, int)
      _setInformationJobObject = kernel32.lookupFunction<
          Int32 Function(Pointer<Void>, Int32, Pointer<Void>, Uint32),
          int Function(Pointer<Void>, int, Pointer<Void>, int)>(
        'SetInformationJobObject',
      );

  late final Pointer<Void> Function() _getProcessHeap =
      kernel32.lookupFunction<Pointer<Void> Function(), Pointer<Void> Function()>(
        'GetProcessHeap',
      );

  late final Pointer<Void> Function(Pointer<Void>, int, int) _heapAlloc =
      kernel32.lookupFunction<
          Pointer<Void> Function(Pointer<Void>, Uint32, Uint64),
          Pointer<Void> Function(Pointer<Void>, int, int)>('HeapAlloc');

  late final int Function(Pointer<Void>, int, Pointer<Void>) _heapFree =
      kernel32.lookupFunction<
          Int32 Function(Pointer<Void>, Uint32, Pointer<Void>),
          int Function(Pointer<Void>, int, Pointer<Void>)>('HeapFree');

  static const int _processSetQuota = 0x0100;
  static const int _processTerminate = 0x0001;
  static const int _heapZeroMemory = 0x0008;
  static const int _jobObjectExtendedLimitInformation = 9;
  static const int _killOnJobClose = 0x00002000;

  /// Size of JOBOBJECT_EXTENDED_LIMIT_INFORMATION on x64.
  static const int _extendedLimitInfoSize = 144;

  /// Offset of LimitFlags inside JOBOBJECT_EXTENDED_LIMIT_INFORMATION.
  static const int _limitFlagsOffset = 16;

  Pointer<Void> _job = nullptr;
  bool _disposed = false;

  /// True when the job object was created and the child was attached.
  bool get attached => _job != nullptr && !_disposed;

  /// Puts [pid] into this process's job so it dies with the app.
  /// Returns false when the OS refuses (should not happen on Windows 10/11).
  bool attach(int pid) {
    if (_disposed) return false;
    final job = _createJobObjectW(nullptr, nullptr);
    if (job == nullptr) return false;

    final info = _heapAlloc(_getProcessHeap(), _heapZeroMemory, _extendedLimitInfoSize);
    if (info == nullptr) return false;
    try {
      (info.cast<Uint8>() + _limitFlagsOffset).cast<Uint32>().value =
          _killOnJobClose;
      final setOk = _setInformationJobObject(
        job,
        _jobObjectExtendedLimitInformation,
        info,
        _extendedLimitInfoSize,
      );
      if (setOk == 0) return false;
    } finally {
      _heapFree(_getProcessHeap(), 0, info);
    }

    final handle = _openProcess(
      _processSetQuota | _processTerminate,
      0,
      pid,
    );
    if (handle == nullptr) return false;
    final assignOk = _assignProcessToJobObject(job, handle);
    // The process handle is no longer needed once assignment succeeded/failed.
    _closeHandle(handle);
    if (assignOk == 0) {
      _closeHandle(job);
      return false;
    }

    _job = job;
    return true;
  }

  /// Closes the job handle. If the app is still alive the children keep
  /// running; call this only together with an explicit kill, or on shutdown
  /// (closing the handle is what triggers KILL_ON_JOB_CLOSE).
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    if (_job != nullptr) {
      _closeHandle(_job);
      _job = nullptr;
    }
  }

  late final int Function(Pointer<Void>) _closeHandle = kernel32
      .lookupFunction<Int32 Function(Pointer<Void>), int Function(Pointer<Void>)>(
        'CloseHandle',
      );
}
