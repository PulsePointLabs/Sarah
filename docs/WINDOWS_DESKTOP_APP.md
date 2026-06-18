# Sarah Windows Desktop App

Sarah can be packaged as a real Windows desktop app with Electron. Electron is only the window/package layer; the local Express API still starts the Sarah telemetry engine and owns timing, buffering, SQLite writes, uploads, generated media, and Live Capture backend routes.

## Commands

```powershell
npm run desktop:dev
npm run desktop:pack
npm run desktop:dist:win
```

- `desktop:dev` builds the React frontend, starts Electron, starts the backend automatically, waits for `/api/health`, and opens the native desktop window.
- `desktop:pack` creates an unpacked Windows app at `desktop-release/win-unpacked/Sarah.exe`.
- `desktop:dist:win` currently produces the same runnable unpacked Windows app. This is the reliable packaging path for the current native SQLite stack.

## Runtime Data

Portable project builds launched from `desktop-release/win-unpacked/Sarah.exe` use the existing project data when available:

- SQLite: `data/pulsepoint.sqlite`
- Uploads/media: `data/uploads`
- TTS render work: `data/tts-render-work`
- HR recordings: `data/heart-rate-recordings`

If no project database is found, Sarah falls back to Electron's user data directory:

- SQLite: `%APPDATA%\Sarah\data\sarah.sqlite`
- Uploads/media: `%APPDATA%\Sarah\data\uploads`
- TTS render work: `%APPDATA%\Sarah\data\tts-render-work`
- HR recordings: `%APPDATA%\Sarah\HeartRate\recordings`
- EMG text bridge: `%APPDATA%\Sarah\EMG` unless `EMG_TEXT_DIR` is explicitly provided

The regular web/dev workflow still uses the repo defaults unless these environment variables are set.

## Architecture

```text
Sarah.exe
  -> Electron main process
  -> starts backend child process with ELECTRON_RUN_AS_NODE
  -> backend starts Express + SQLite + local telemetry engine
  -> Electron waits for /api/health
  -> Electron loads built frontend from the local backend
```

The Live Capture UI still subscribes to engine snapshots. Raw telemetry is timestamped and queued by the backend engine, not by React rendering.

## Direct Polar H10

The desktop window handles Electron's Web Bluetooth selection event for Direct Polar H10 capture. When Live Capture asks for the H10, Sarah scans for a device named `Polar H10`/`H10` and selects it for the renderer. Bluetooth scan details are written to `%APPDATA%\Sarah\logs\desktop.log`.

The desktop backend also allocates its own HR relay port at startup and points `/api/live-capture` at that relay, so a stale dev server on `8765` does not block the packaged app.
