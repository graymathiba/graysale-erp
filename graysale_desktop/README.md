# GraySale Desktop

Windows 10/11 x64 desktop host for the GraySale ERP. The app starts (or
reuses) the bundled local Node server and shows the ERP in an embedded
WebView2 window, so the shop can run GraySale from a single double-click.

## Build

Requires the Flutter Windows toolchain (MSVC via Visual Studio, CMake, Git):

```
flutter pub get
flutter analyze
flutter build windows --release
```

Output: `build\windows\x64\runner\Release\graysale_desktop.exe`

> Note: `windows\CMakeLists.txt` strips the legacy `/await` flag from the
> `webview_windows` plugin — recent MSVC STLs hard-error on the
> `<experimental/coroutine>` header it pulls in. The plugin builds with
> native C++20 coroutines instead. Keep that patch when upgrading Flutter.

## Ship layout

The server bundle sits **next to** the executable:

```
Release\
├── graysale_desktop.exe
├── flutter_windows_*.dll, *.pdb, data\...   (Flutter build output)
└── GraySaleServer\
    ├── node\
    │   └── node.exe          (bundled Node.js >= 22.5, x64)
    └── app\
        ├── package.json
        ├── src\
        │   └── server.js     (+ the rest of the server sources)
        └── web\
            └── dist\         (built web UI)
```

`scripts/package-win.mjs` in the GraySale repo produces the `GraySaleServer`
tree contents (its `app` + `runtime\node` folders map to `app` + `node` here).

## Runtime behaviour

- On launch the app probes `http://127.0.0.1:<port>/api/v1/health`. If a
  server already answers `{"ok":true}`, it is **adopted** (never spawned, and
  never killed by this app) — running two instances is safe.
- Otherwise it spawns `GraySaleServer\node\node.exe GraySaleServer\app\src\server.js`
  with `NODE_ENV=production`, `GRAYSTORAGE_ROOT` and `PORT` set, polls health
  for up to 60 s, then loads the UI. Startup output is appended to
  `%LOCALAPPDATA%\GraySale\server.log` and shown on the failure screen.
- A spawned server is tied to the app with a Win32 job object, so closing or
  killing the window always takes the server process tree down with it.
  An adopted server is left untouched.
- Data lives in `%LOCALAPPDATA%\GraySale\data` (created on first run).

## WebView2 runtime

The embedded browser uses the Microsoft Edge WebView2 (Evergreen) runtime,
pre-installed on Windows 11 and most updated Windows 10 machines. If it is
missing, the app shows a notice and an **Open in browser** button that opens
`http://localhost:<port>/` in the default browser while the window (and the
server) stays up. Download: https://developer.microsoft.com/microsoft-edge/webview2/

## Environment overrides

| Variable              | Default                     | Effect                                   |
| --------------------- | --------------------------- | ---------------------------------------- |
| `GRAYSALE_PORT`       | `3030`                      | Port to probe and spawn the server on.   |
| `GRAYSALE_SERVER_DIR` | `<exe dir>\GraySaleServer`  | Location of the bundled server bundle.   |

The spawned Node process additionally receives `PORT`, `NODE_ENV=production`
and `GRAYSTORAGE_ROOT=%LOCALAPPDATA%\GraySale\data`, matching the
`GraySale.bat` launcher contract.
