# Sarah Windows-Local Telemetry Engine

Phase 1 separates Sarah's real-time telemetry path from React rendering.

## Runtime Shape

```text
HR / EMG source
  -> server/localEngine TelemetryEngine
  -> monotonic timestamp + ring buffers + append-only queue
  -> SQLite local_telemetry_events writes
  -> throttled SSE snapshot to Live Capture
```

The React UI is only the cockpit. The engine owns timestamping, buffering, storage queueing, and status.

## Current Process Model

The engine currently runs inside the local Node API process (`npm run server`) so the existing app keeps working. It is isolated under `server/localEngine` so a Windows package can later start it as a child process or Windows service without moving Live Capture logic again.

## Future Windows Package Map

- Start local API / engine process.
- Serve the built React app from the same local runtime or a packaged static server.
- Open a desktop window with Electron, WebView2, or a small native shell.
- On app close, send shutdown to the engine process, flush the telemetry queue, then close the UI.

Electron can be the window later; it is not the latency fix. The latency fix is the engine-owned telemetry path.
