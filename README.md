# PulsePoint Standalone 🫀

PulsePoint is a private, local-first review workspace for intimate physiology sessions: recorded media, heart-rate and optional EMG telemetry, timestamped observations, session notes, AI-assisted analysis, Motion Lab evidence, and narrated audio summaries.

It is not trying to be a generic health dashboard. It is the **“what actually happened here?”** pass after a recorded session — the place where signals, notes, video, and body-context get reviewed together instead of living in five different folders.

This project began as a Base44 app and is being migrated into a standalone local web app with a local API server. The overall design goal is simple: **high-context review, strong privacy boundaries, and useful analysis without pretending the app is a medical device.**

## What PulsePoint Does ✨

### 🎥 Review and annotate sessions

- Session detail pages for subjective metrics, notes, physiology markers, media, and post-session review.
- A Video Sync Player that aligns local video with heart-rate data and timestamped event notes.
- AI-assisted event tagging for observations such as stimulation changes, physical findings, sensation, approach, climax, and recovery.
- Session review flows that preserve both the signal data and the human context around it.

### 📈 Follow physiology and movement signals

- Heart-rate CSV import and timeline visualization.
- Live Capture telemetry with current HR, trend lines, phase watch, and optional EMG data.
- EMG import and visualization for MyoWare-derived signal data when available.
- Motion Lab for local-only video-derived movement evidence, including region motion, hand activity, foot/leg activity, manual landmarks, and marker-assisted foot geometry experiments.
- Session, trend, cascade, insight, profiler, and comparison views for longitudinal analysis.

### 🧠 Add AI interpretation carefully

- AI Session Analysis, Technical Deep Dive, Cascade Analysis, Profiler, Insights, phase suggestions, and journal/storyline generation.
- Shared profile context so analysis can use session details, event timelines, notes, journal entries, saved profile context, and reviewed Motion Lab evidence.
- Background jobs for heavier AI and audio work so long tasks can continue while the UI changes focus.
- Guardrails that treat telemetry and motion evidence as **observational support**, not diagnostic proof.

### 🎧 Listen back

- Tuned Nova TTS narration with a centralized Settings & Status page.
- Premium server-side audio rendering and an Audio Library for completed exports.
- Downloadable audio summaries for slower, more immersive review away from the screen.

## Current Status 🚧

PulsePoint is actively evolving. The core app runs locally, but some areas are still in “move carefully, there are wires everywhere” territory:

- Base44-to-standalone migration is mostly working but still being hardened.
- Motion Lab UI and marker-assisted foot geometry tracking are under active iteration.
- AI prompts and evidence plumbing are being refined so session analysis, technical deep dives, profiler output, and cascade analysis all see the right context.
- TTS quality, chunking, and narration behavior are important parts of the experience and get treated as first-class features.

Contributions are welcome, especially when they help make the app more stable, understandable, private, and maintainable.

## Tech Stack 🛠️

- **Frontend:** React 18, Vite, Tailwind, Radix UI, Recharts
- **Backend:** Node.js, Express, SQLite via `better-sqlite3`
- **AI/TTS providers:** OpenAI and Anthropic, configured through local environment variables
- **Local telemetry helpers:** Heart-rate relay, OBS-aware capture helpers, optional EMG scripts
- **Computer vision:** MediaPipe Tasks Vision for local video-derived motion evidence

## Quick Start 🚀

Install dependencies:

```bash
npm install
```

Create a local environment file:

```bash
cp .env.example .env
```

Add whichever provider keys you want to use:

```bash
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
```

Run frontend and backend together:

```bash
npm run dev:all
```

Default local URLs:

- App: `http://localhost:5173`
- API: `http://localhost:8787`

You can also run them separately:

```bash
npm run server
npm run dev -- --host
```

Build the frontend:

```bash
npm run build
```

Run lint:

```bash
npm run lint
```

## Current Capture Stack 🎛️

PulsePoint can work from manually entered sessions and imported files alone. The richer live-capture workflow uses a small hardware/software chain.

### Required for the core app

- Node.js and npm
- a local browser
- PulsePoint frontend and local API server

### Used for heart-rate capture

- **HeartRateOnStream** for live heart-rate telemetry
- currently tested wearable source: **Samsung Galaxy Watch 7**
- embedded PulsePoint HR relay started by the local API server
- fallback helper assets in [`tools/capture/heart-rate`](tools/capture/heart-rate)

The heart-rate relay receives live telemetry, exposes the WebSocket feed used by Live Capture, and writes HR CSV recordings when the OBS-driven recording flow is active. In the default setup it lives inside `npm run server`, so HR capture does not need its own extra terminal.

### Used for EMG capture

- **MyoWare EMG** hardware
- a serial-connected microcontroller feed for the MyoWare signal
- Python helpers and OBS overlays in [`tools/capture/emg`](tools/capture/emg)

PulsePoint treats EMG as optional. HR can stand alone. EMG appears in Live Capture and analysis only when the signal source is live or session data has been attached.

### Used for recorded media

- **OBS Studio** is the current recording and automation center.
- OBS is not required for imported-session review.
- OBS is very useful for synchronized capture timing, overlays, and a clean video record to review later.

In the current live workflow, OBS recording start is the natural session boundary: HR/EMG helper tools can log around that recording window, and PulsePoint can turn the finished capture into a new session for review. 🎬

## Motion Lab 🧪

Motion Lab is the local-only video review and movement-evidence workspace. It is designed to extract **derived evidence**, not store raw video.

Current capabilities include:

- local video loading from the browser
- region-based left/right foot or lower-body activity tracking
- optional forefoot/toe-region comparison
- hand movement activity and cadence proxy experiments
- position-change / region-segment handling for videos where framing shifts
- manual foot landmark calibration
- marker-assisted foot geometry experiments using high-contrast / reflective markers
- reviewed findings that can be promoted into the session timeline

Important caveat: Motion Lab movement signals are observational. They should be verified against the video and interpreted alongside session notes, HR/EMG telemetry, and context.

## Capture Helper Code Lives Here Now 📦

The HeartRate and EMG helper source used by this setup lives inside the repo:

- [`tools/capture/heart-rate`](tools/capture/heart-rate)
- [`tools/capture/emg`](tools/capture/emg)
- [`tools/capture/README.md`](tools/capture/README.md)

Only source code, helper overlays, and local dependency metadata belong there. Recordings, text feeds, EMG session exports, calibration files, and generated telemetry are intentionally ignored.

The standalone API still keeps the existing sibling-folder defaults for capture data so a working setup does not silently break. When ready, point `.env` at the in-repo helper output paths or run the in-repo helpers directly.

## Capture Helper Setup

### Heart-rate relay

The PulsePoint API starts the HR relay by default:

```bash
npm run server
```

The standalone helper is still available for troubleshooting or older workflows:

```bash
npm run capture:hr:install
npm run capture:hr
```

### EMG helpers

Install the Python requirements for the EMG scripts:

```bash
npm run capture:emg:install
```

Run the helper that matches the setup:

```bash
npm run capture:emg:dual
```

or

```bash
npm run capture:emg:single
```

Common capture knobs can be set through environment values such as `EMG_SERIAL_PORT`, `EMG_SERIAL_BAUD`, `OBS_HOST`, `OBS_PORT`, and `EMG_OBS_ENABLED`. When launched from the repo root, their live text files and session CSVs stay under `tools/capture/emg/`.

## Local Configuration ⚙️

`server/config.js` centralizes local paths. The defaults keep the current sibling-folder capture layout working, while `.env` can override it:

- `DATABASE_PATH`, `UPLOAD_DIR`, and `TTS_RENDER_DIR` control local app storage.
- `HR_CAPTURE_RELAY_ENABLED` controls the embedded HR relay started with the API.
- `HR_CAPTURE_RELAY_PORT` and `HR_CAPTURE_WS_URL` keep its WebSocket address configurable.
- `OBS_WS_URL` and `OBS_PASSWORD` let the embedded relay follow OBS recording state.
- `HR_RECORDINGS_DIR` points at heart-rate CSV recordings.
- `EMG_TEXT_DIR` points at live EMG telemetry text files.
- `EMG_SESSIONS_DIR` points at EMG CSV session exports.
- `BACKGROUND_JOB_CONCURRENCY` keeps local background queue throughput explicit.

For the repo-local capture helpers, these are the matching output locations:

```bash
HR_RECORDINGS_DIR=./tools/capture/heart-rate/recordings
EMG_TEXT_DIR=./tools/capture/emg
EMG_SESSIONS_DIR=./tools/capture/emg/emg_sessions
```

## Settings & Status

The Settings & Status page centralizes:

- Nova TTS tuning and presets
- background task visibility and cancellation
- stale or hung job review
- provider cost-report visibility when optional admin reporting keys are configured

The app uses ordinary OpenAI and Anthropic API keys for TTS and AI work. Optional admin reporting keys can add cost-report visibility:

```bash
OPENAI_ADMIN_API_KEY=your_openai_admin_key
ANTHROPIC_ADMIN_API_KEY=your_anthropic_admin_key
```

## Remote / Mobile Testing 📱

For private mobile testing, Tailscale is the preferred path.

Example Tailscale Serve command:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:5173
```

If you are testing multiple local apps, keep each app on a distinct HTTPS origin/port so browser PWA installs and service workers do not get confused.

## Data and Privacy 🔐

PulsePoint is intentionally local-first. Treat the workspace and `data/` directory as sensitive.

Important local data areas:

- `data/uploads/` stores generated and uploaded files.
- `ProcessingJob` records track backend AI/TTS job status and results.
- browser local storage may contain active TTS job IDs and TTS preferences.
- capture helper output folders can contain raw physiology telemetry and session exports.

Raw video is not meant to be committed, uploaded, or persisted by Motion Lab. The app is designed to save reviewed summaries, derived telemetry, and explicitly accepted observations.

## For Contributors 🤝

A few norms that make this project easier to work on:

- Prefer small, focused branches and commits.
- Do not commit private recordings, telemetry exports, `.env`, generated audio, or local database files.
- Keep AI/motion interpretation cautious: derived signals support review, they do not prove intent, diagnosis, or physiology by themselves.
- Preserve local-first behavior unless a feature explicitly says otherwise.
- Run `npm run build` before handing off larger UI or data-flow changes.

Useful validation commands:

```bash
npm run lint
npm run build
```

## Notes 📝

- Nova is the primary tuned TTS voice for the app experience. 🎙️
- Premium TTS quality depends on the selected engine, export format, and server-side renderer.
- Motion Lab is under active development; verify important movement findings against the source video.
- Restart `npm run server` after backend route, config, or job changes.
