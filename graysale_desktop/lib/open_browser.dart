import 'dart:io';

/// Opens the GraySale URL in the user's default browser.
Future<void> openInBrowser(int port) {
  return Process.run(
    'cmd.exe',
    <String>['/c', 'start', 'http://localhost:$port/'],
  );
}
