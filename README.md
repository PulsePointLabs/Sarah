# Sarah

Sarah is a private, local-first review workspace for personal physiology sessions. It brings together session notes, heart-rate and HRV telemetry, optional EMG, local video, audio, annotations, body-exploration records, Profile Q&A, and AI-assisted review.

It is not a generic wellness dashboard. Sarah is the "what actually happened here?" workspace: the place where signals, observations, media, and body context can be reviewed together instead of living in disconnected files.

The project began as a Base44 app and is being migrated into a standalone local web app with a local API server. The goal is high-context review, strong privacy boundaries, exportable data, and useful analysis without pretending the app is a medical device.

## Current Shape

PulsePoint now covers five main workflows:

- **Session review:** create, edit, annotate, analyze, compare, export, and listen back to recorded sessions.
- **Body exploration:** track non-session anatomical/procedure-style exploration separately from active stimulation sessions.
- **Live capture:** monitor HR, HRV/RR intervals, capture phase context, Pulsoid, Polar H10, and optional EMG while recording.
- **AI evidence building:** use Profile Q&A, session Q&A, image/video review, AI video passes, annotations, and profile metrics as persistent context.
- **Longitudinal analysis:** build profile, cascade, insight, correlation, trend, predictive, and profiler views from accumulated evidence.

The app is still evolving quickly, but the core standalone stack is usable locally.

## Major Features

### Sessions and Annotations

- Rich session detail pages with subjective metrics, notes, physiological markers, linked local videos, event timelines, and post-session review.
- Editable in-place event annotations on Session Detail and Video Sync pages, including delete confirmation.
- AI-assisted annotation workbench for finding useful event candidates from existing session context.
- AI phase marker suggestions for climax/recovery timing with explicit caution around ambiguous fluid, pre-ejaculate, lubricant, HR peaks, and unsupported timeline claims.
- Persistent Session Details AI Q&A history, including saved chat restoration on page load.
- Export helpers for session data and summaries.

### Body Exploration

- Separate body-exploration records for anatomical/procedure-focused review that should not be interpreted as active stimulation by default.
- Dedicated Body Exploration detail pages with AI chat, linked local video review, AI video/audio passes, and timeline drafting.
- Prompt grounding for procedure/body-state interpretation: swabs, applicators, glans/meatus contact, Foley catheters, urethral sounds/dilators, tissue state, body response, and comfort/tolerance cues.
- Stronger anti-overcall rules so visual review does not turn a swab, wipe, or applicator into a catheter/sound advancement unless the device is clearly visible or explicitly anchored by notes.

### AI Video and Audio Review

- AI video-pass review for regular sessions and body explorations.
- Sampled frame evidence from linked local video clips, with media context saved back into session/body-exploration AI evidence.
- Audio pass support for AI interpretation where audio adds useful context.
- Draft timeline event generation for meaningful visual or audio findings.
- Source-lane rules for main/genital-composite, body exploration/procedure, feet/lower-body, and lateral/full-body camera views.
- Direct, clinically accurate wording rules where useful. For example, future video review says `ejaculate` or `visible ejaculate` when evidence supports it, instead of euphemistic residue language.

### AI Profiler

- Comprehensive Physiological Profile synthesis from sessions, journals, profile metrics, Q&A, telemetry, and reviewed evidence.
- Anatomical & Physiological Profile with run archive and TTS playback.
- Head-to-Toe Image Review and Pelvic & Genital Image Review panels.
- Existing-evidence-first profiler reviews: Sarah can synthesize from saved Profile Q&A findings, session visual reviews, body-exploration visual reviews, AI video-pass findings, entered profile metrics, and session evidence without requiring a fresh upload.
- Fresh images remain optional supplemental evidence.
- Profile Q&A findings are persisted and reused as structured evidence rather than relying on a model's hidden memory.

### Live Capture

- Condensed Live Capture flow with collapsed settings and cleaner controls.
- Current HR, trend, phase context, status cards, and telemetry dashboard.
- Direct Polar H10 support through Web Bluetooth where the browser supports it.
- Direct H10 RR/HRV ingestion and session evidence plumbing.
- Pulsoid and HeartRateOnStream-compatible relay paths.
- Optional EMG telemetry display and capture helper integration.
- Foreground stability work for Android installed PWA/SWA usage so returning to the app is less likely to reload the whole shell.

### Motion and Media Evidence

- Motion Lab for local-only video-derived movement evidence.
- Region motion, hand activity, cadence proxy experiments, lower-body/foot activity, position segments, manual landmarks, and marker-assisted foot geometry.
- Reviewed motion findings can be promoted into session timelines.
- Local video is used in-browser; PulsePoint is designed to persist reviewed findings and derived evidence, not raw private video.

### TTS and Audio Library

- Centralized TTS settings for Nova-style narration.
- TTSReader / AIOutputReader playback for long AI outputs with sentence highlighting.
- Premium server-side rendering for longer audio summaries.
- Audio Library for completed exports.
- Background jobs for AI/TTS work with visible status, cancellation, completion notifications, and stale/hung indicators.

### Mobile / PWA

- Installable PWA/SWA-style experience on Android.
- Capacitor Android APK scaffold under `android/`; see [`docs/APK_BUILD.md`](docs/APK_BUILD.md) for the debug APK build path.
- Service worker shell caching tuned to reduce foreground-return reloads.
- Local notification support for Settings test alerts and background task completion alerts while the app/service worker is available.
- Current notification support is local browser/PWA notification support, not full remote push. True closed-app push would require VAPID keys, push subscriptions, subscription storage, and backend send routes.

## Tech Stack

- **Frontend:** React 18, Vite, Tailwind, Radix UI, Recharts
- **Backend:** Node.js, Express, SQLite via `better-sqlite3`
- **AI/TTS providers:** Anthropic and OpenAI through local environment variables
- **TTS/STT:** OpenAI TTS and Whisper-backed voice input where configured
- **Computer vision:** MediaPipe Tasks Vision for local video-derived evidence
- **Telemetry helpers:** WebSocket HR relay, OBS-aware capture helpers, optional Python EMG scripts
- **Mobile shell:** browser PWA/service worker

## Quick Start

Install dependencies:

```bash
npm install
```

Create a local environment file:

```bash
cp .env.example .env
```

Add provider keys as needed:

```bash
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
```

Run frontend and backend together:

```bash
npm run dev:all
```

Default local URLs:

- App: `http://localhost:5174`
- API: `http://localhost:8787`

Run separately when useful:

```bash
npm run server
npm run dev -- --host
```

Build:

```bash
npm run build
```

Lint:

```bash
npm run lint
```

## Local Configuration

`server/config.js` centralizes local paths and runtime knobs. The defaults keep the current local data layout working, while `.env` can override it.

Common values:

- `DATABASE_PATH`, `UPLOAD_DIR`, and `TTS_RENDER_DIR` control local app storage.
- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` power AI/TTS/STT features.
- `ANTHROPIC_MODEL` can pin the Claude model family used by local analysis routes.
- `OPENAI_TTS_MODEL`, `OPENAI_TTS_FORMAT`, `OPENAI_TTS_SPEED`, and related values tune server-side TTS defaults.
- `BACKGROUND_JOB_CONCURRENCY` controls local queue throughput.
- `HR_CAPTURE_RELAY_ENABLED`, `HR_CAPTURE_RELAY_PORT`, and `HR_CAPTURE_WS_URL` configure the embedded HR relay.
- `OBS_WS_URL` and `OBS_PASSWORD` let capture helpers follow OBS recording state.
- `HR_RECORDINGS_DIR`, `EMG_TEXT_DIR`, and `EMG_SESSIONS_DIR` point at generated telemetry folders.
- `OPENAI_ADMIN_API_KEY` and `ANTHROPIC_ADMIN_API_KEY` optionally enable provider cost visibility in Settings & Status.

Repo-local helper output alternatives:

```bash
HR_RECORDINGS_DIR=./tools/capture/heart-rate/recordings
EMG_TEXT_DIR=./tools/capture/emg
EMG_SESSIONS_DIR=./tools/capture/emg/emg_sessions
```

## Capture Stack

PulsePoint works with manually entered sessions and imported files. The richer live workflow can use HR, HRV/RR, OBS, and EMG.

### Heart Rate and HRV

Supported or evolving sources include:

- Direct Polar H10 via browser Bluetooth where supported
- Pulsoid live telemetry
- HeartRateOnStream-compatible local relay
- imported heart-rate CSV timelines

PulsePoint can ingest HR timelines and RR/HRV evidence for session analysis, profiler synthesis, Live Capture, and longitudinal review.

The embedded relay starts with:

```bash
npm run server
```

The standalone relay remains available for troubleshooting:

```bash
npm run capture:hr:install
npm run capture:hr
```

### EMG

EMG is optional. HR can stand alone.

The repo includes Python helpers for MyoWare-style EMG workflows:

```bash
npm run capture:emg:install
npm run capture:emg:dual
npm run capture:emg:single
```

Common overrides:

```bash
EMG_SERIAL_PORT=COM5
EMG_SERIAL_BAUD=115200
EMG_OBS_ENABLED=true
OBS_HOST=127.0.0.1
OBS_PORT=4455
```

### OBS and Recorded Media

OBS Studio is the current recording and automation center for synchronized capture timing, overlays, and clean video records.

OBS is not required for imported-session review, but it is useful for capture sessions where HR/EMG helper tools should align with the recording window.

## Main App Areas

- `/sessions` - session list and bulk analysis tools
- `/sessions/:id` - session detail, Q&A, media review, annotations, export, and AI outputs
- `/exploration` - body exploration records
- `/capture` - live capture and telemetry dashboard
- `/profiler` - AI Profiler and anatomical/profile synthesis
- `/profile-qa` - Profile Q&A and persistent profile findings
- `/profile` - entered metrics, physiological profile, and anatomical/mechanical profile fields
- `/video` - Video Sync player
- `/ai-annotation` - AI-assisted annotation workbench
- `/motion-lab` - local video-derived movement evidence
- `/settings` - TTS, notifications, provider visibility, background tasks, and display/readability settings

## Settings & Status

The Settings & Status page centralizes:

- Nova TTS tuning and presets
- display/readability themes and font scale
- local notification permission and test alerts
- background task visibility, cancellation, stale/hung review, and completion notifications
- provider API status and optional cost-report visibility

Local completion notifications work while PulsePoint is open or available to the PWA/service worker. Fully closed-app remote delivery is intentionally not claimed yet.

## Remote / Mobile Testing

For private mobile testing, Tailscale is the preferred path.

Example Tailscale Serve command:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:5174
```

If testing multiple local apps, keep each app on a distinct HTTPS origin/port so PWA installs and service workers do not collide.

On Android:

- install from the served HTTPS origin when possible
- grant notification permission from Settings & Status
- use the Settings test notification first
- expect local completion alerts while the PWA is alive/backgrounded, not guaranteed closed-app push
- if service-worker behavior looks stale after a deploy, close/reopen the installed app or reinstall the PWA

## Data and Privacy

PulsePoint is intentionally local-first. Treat the workspace, `.env`, and `data/` as sensitive.

Important local data areas:

- `data/uploads/` stores generated and uploaded files.
- `data/pulsepoint.sqlite` stores local app data by default.
- `ProcessingJob` records track backend AI/TTS job status and results.
- browser local storage may contain TTS preferences, active jobs, UI preferences, notification preferences, and cached app state.
- capture helper output folders can contain raw physiology telemetry and session exports.

Do not commit:

- `.env`
- raw recordings or private video
- generated audio
- telemetry exports
- local SQLite databases
- capture helper live text feeds, calibration files, or session CSVs
- Codex remote attachment folders

AI APIs receive whatever text/media frames are sent for a requested analysis. Keep secrets out of client code and avoid logging sensitive session data.

## Development Notes

- Prefer small branches and focused commits.
- Preserve local-first behavior unless a feature explicitly requires a remote path.
- Keep AI interpretation cautious: telemetry, motion, image, and audio evidence support review; they do not prove intent, diagnosis, force, pain, or physiology by themselves.
- Session and profile evidence is cumulative. When changing AI prompts, check whether Profile Q&A, visual evidence, session event timelines, body exploration, and entered metrics still flow through.
- TTS/Nova cadence matters. Do not casually change chunking, sentence boundaries, or voice settings.
- Restart `npm run server` after backend route, config, or job changes.

## Current AI Direction and Collaborator Notes

PulsePoint is being developed as a serious, private physiology and evidence-review tool. Adult anatomy, pelvic/genital reference review, masturbation physiology, Foley/procedure review, and body exploration are valid in-scope data domains when handled clinically and non-erotically.

Near-term AI priorities:

- **Local AI Annotation is the main active gap.** The target is Sarah-style chronological video/window cards with timestamp range, visible evidence, change from prior window, confidence/limitations, event tags, frame references, and provenance. Raw CV/Qwen rows should remain debug evidence, not the primary user-facing result.
- **Cloud Sarah / Claude remains the reference path.** Claude video-pass and session-analysis outputs are currently the quality bar for chronological, evidence-based interpretation.
- **Session Analysis is Claude-only right now.** The attempted local Sarah text synthesis path is disabled because local packet summaries were too robotic and unreliable for the Sarah-quality narrative target.
- **AI Profiler image review now preserves batch work when final synthesis times out.** If the final Pelvic & Genital or Head-to-Toe synthesis fails after batch reviews complete, the UI may show “Latest final synthesis failed” while also showing “recovered latest batch findings assembled locally.” That state means the batch-level visual review completed and the app is displaying an interim assembled review instead of losing paid-for or time-consuming batch evidence. Repeatedly retrying the same large final synthesis may time out again; use the recovered batch findings as the current working review unless a smaller or compressed synthesis pass is implemented.

Evidence discipline rules:

- Keep direct visual evidence, saved profile/prior-evidence reconciliation, telemetry evidence, user-reported context, and interpretation separate.
- Do not infer subjective experience, intent, pain, arousal, orgasm, diagnosis, catheter advancement, fluid release, or device insertion unless the evidence actually supports that specific claim.
- Local-only workflows must not silently fall back to cloud.
- Do not loosen local vision gates to make results look more confident.
- Do not touch TTS/Nova behavior casually.

Female/woman-friendly expansion is planned. The same evidence-first approach should support female anatomy and session workflows with clinical, practical language: vulvar/labial visibility, clitoral hood/clitoral region visibility, vaginal introitus visibility, perineal body visibility, visible lubrication/fluid evidence, manual/device contact when visible, pelvic/leg/foot movement, tissue irritation/redness/swelling when visible, post-event cleanup/fluid presence, and clear limitations when visibility is inadequate. This should be built as first-class product support, not as a male-session afterthought.

Useful validation:

```bash
npm run lint
npm run build
```

For narrow frontend edits, focused commands are often faster:

```bash
.\node_modules\.bin\eslint.cmd path\to\File.jsx --quiet
.\node_modules\.bin\vite.cmd build
```

## Capture Helper Code

Helper source lives in:

- [`tools/capture/heart-rate`](tools/capture/heart-rate)
- [`tools/capture/emg`](tools/capture/emg)
- [`tools/capture/README.md`](tools/capture/README.md)

Only source code, helper overlays, and dependency metadata belong there. Recordings, text feeds, EMG session exports, calibration files, and generated telemetry are ignored.

## Status

PulsePoint is active, private, and moving fast. The standalone app is usable locally, with the highest-change areas currently being:

- AI prompt grounding and reviewed-evidence persistence
- Live Capture hardware/source polish
- Android PWA behavior
- body exploration analysis
- profiler/anatomical synthesis
- Motion Lab evidence workflows

When in doubt, favor boring data structures, explicit evidence, local storage, and reversible changes.
