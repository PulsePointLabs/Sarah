# Sarah 💜

Private, local-first physiology and session review.

Sarah is a personal physiology workspace built on the PulsePoint engine.

It brings together telemetry, video, audio, annotations, body observations, AI-assisted review, and longitudinal context so they can be understood as one coherent record instead of a pile of disconnected files.

It is not another generic wellness dashboard.

Sarah is the place to ask:

What actually happened, what changed, and what does the available evidence suggest?

Metrics are evidence. The story is the product.

---

## What Sarah Does 🧠📈

Sarah supports several connected workflows.

### 🎬 Session Review

Create and review detailed physiology sessions with:

- notes and subjective observations
- heart-rate and HRV timelines
- timestamped annotations
- linked local recordings
- AI-assisted analysis
- historical comparison
- exports and narrated summaries

Sessions remain editable, searchable, and available for future comparison.

### 🫀 Live Capture

Monitor physiology while recording a session.

Supported or evolving inputs include:

- Polar H10
- heart rate
- RR intervals and HRV
- Pulsoid
- HeartRateOnStream-compatible relays
- imported telemetry
- optional EMG
- OBS-aware capture helpers

The local telemetry engine handles timing, buffering, storage, and live updates independently from the interface.

### 🧍 Body Exploration

Body Exploration provides a separate workspace for focused anatomy, procedure, comfort, movement, and body-state documentation.

These records can include:

- written observations
- subjective sensations
- photos and local video
- timeline annotations
- telemetry
- AI-assisted review
- longitudinal comparison

This keeps focused body documentation separate from ordinary session records when that distinction matters.

### 🔎 AI Video and Audio Review

Sarah can review linked recordings and build structured evidence from:

- sampled video frames
- audio context
- manual notes
- timeline events
- visible changes
- positioning and movement
- physiological telemetry
- confidence and limitations

Reviewed findings can be saved back into the session or profile rather than disappearing after one AI response.

### 🧬 Sarah Profiler

The Profiler builds a cumulative view across:

- sessions
- body explorations
- journals
- entered metrics
- saved Q&A
- image and video findings
- telemetry
- annotations
- previous reviews

Profiler tools include:

- physiological profile synthesis
- anatomical profile review
- Head-to-Toe review
- Pelvic and Genital review
- trends and correlations
- historical comparison
- saved reports and narration

### 🦿 Motion Lab

Motion Lab explores movement evidence derived from local video.

Current tools include:

- regional motion
- hand activity
- lower-body movement
- cadence proxies
- position segments
- manual landmarks
- marker-assisted geometry
- timeline promotion of reviewed findings

Raw recordings remain local. Sarah stores reviewed findings and derived evidence rather than treating private video as disposable cloud cargo.

### 🎙️ Sarah Voice

Long reports can be heard instead of merely stared at.

Sarah includes:

- Nova-style TTS narration
- sentence highlighting
- premium audio rendering
- voice input through Whisper when configured
- saved audio exports
- background AI and TTS jobs
- job progress, cancellation, and status reporting

Cadence matters. Pronunciation matters. Sarah should sound like Sarah, not a GPS reading laboratory results.

### 💻 Desktop, Web, and Mobile

Sarah can currently run as:

- a local web application
- a Windows Electron desktop app
- an installable Android PWA
- a Capacitor Android development build

The Windows desktop package starts the local backend automatically and opens Sarah as a standalone application.

---

## Core Principles 🧾

### Local First

Sarah is designed around local storage and private media.

Your database, recordings, telemetry, generated audio, and local configuration remain on your machine unless you intentionally send selected material to an AI provider for analysis.

### Evidence Before Confidence

Sarah should keep these sources distinct:

- direct visual evidence
- subjective report
- manual annotations
- telemetry
- historical comparison
- AI interpretation
- uncertainty and limitations

Images, telemetry, motion, and audio can support an interpretation. They do not automatically prove diagnosis, intent, pain, arousal, causation, or subjective experience.

### Clinical Without Being Cold

Sarah is designed to discuss anatomy and private physiology directly, practically, and without embarrassment or moralizing.

Warm is good.

Curious is good.

Confidently inventing things is not.

### Not a Medical Device

Sarah is an experimental personal review and documentation tool.

It is not intended to diagnose, treat, prevent, or replace professional medical care.

---

## Installation 🚀

### Requirements

Install the following before starting:

- Git
- Node.js and npm
- Windows, macOS, or Linux
- API keys for AI or voice features you plan to use

Some capture and hardware features have additional requirements described later in this README and under `docs/`.

### 1. Clone the Repository

```bash
git clone https://github.com/PulsePointLabs/Sarah.git
cd Sarah
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Create the Environment File

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS or Linux:

```bash
cp .env.example .env
```

Open `.env` and add the provider keys needed for the features you intend to use.

```env
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
```

Do not commit your `.env` file.

### 4. Start Sarah

Run the frontend and backend together:

```bash
npm run dev:all
```

Default local addresses:

- Sarah: `http://localhost:5174`
- Local API: `http://localhost:8787`

Open Sarah in your browser and you are off to the races. 🏁

---

## Using Sarah 🧭

A typical workflow looks like this:

1. Open Sarah.
2. Create or import a session.
3. Add notes, telemetry, annotations, and linked media.
4. Run the desired AI or visual review.
5. Review, edit, listen to, or export the results.

You do not need every data source for every session.

Heart rate can stand alone.

Video can stand alone.

Manual notes matter.

More evidence may create a richer review, but Sarah should remain useful without turning every session into a NASA launch checklist.

---

## Main App Areas

- `/sessions`
  Session list, review, comparison, and bulk tools.

- `/sessions/:id`
  Session detail, annotations, media, Q&A, AI outputs, and exports.

- `/exploration`
  Body Exploration records.

- `/capture`
  Live telemetry and recording workflow.

- `/profiler`
  Sarah Profiler and anatomical or physiological synthesis.

- `/profile-qa`
  Persistent Profile Q&A and saved findings.

- `/profile`
  Entered metrics and profile information.

- `/video`
  Video Sync player.

- `/ai-annotation`
  AI-assisted annotation workspace.

- `/motion-lab`
  Local movement and landmark analysis.

- `/settings`
  Voice, display, providers, notifications, and background tasks.

---

## Windows Desktop App 🪟

Run Sarah in desktop development mode:

```bash
npm run desktop:dev
```

Build the standalone Windows package:

```bash
npm run desktop:pack
```

The current unpacked application is created at:

```text
desktop-release/win-unpacked/Sarah.exe
```

Additional desktop notes are available in:

```text
docs/WINDOWS_DESKTOP_APP.md
```

---

## Android and PWA 📱

Build and synchronize the Capacitor Android project:

```bash
npm run android:sync
```

Open the Android project:

```bash
npm run android:open
```

Build a debug APK on Windows:

```bash
npm run android:apk:debug
```

See:

```text
docs/APK_BUILD.md
```

Sarah can also be installed as a PWA from a secure HTTPS origin.

For private access across devices, Tailscale is the preferred testing path.

Example:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:5174
```

---

## Heart Rate and HRV ❤️

Sarah supports or is actively developing support for:

- Polar H10 through compatible Web Bluetooth environments
- Pulsoid
- HeartRateOnStream-compatible local relays
- imported heart-rate CSV files
- RR interval and HRV evidence

Start the standalone heart-rate relay when needed:

```bash
npm run capture:hr:install
npm run capture:hr
```

The built-in local telemetry engine remains the primary timing and storage layer for the desktop application.

---

## Optional EMG ⚡

EMG is optional. Sarah does not require it.

Install the Python dependencies:

```bash
npm run capture:emg:install
```

Run dual-channel capture:

```bash
npm run capture:emg:dual
```

Run single-channel capture:

```bash
npm run capture:emg:single
```

Hardware, serial-port, and OBS settings can be configured through environment variables and the helper scripts under:

```text
tools/capture/emg
```

---

## OBS and Recorded Media 📹

OBS Studio can be used as the recording and automation center for synchronized capture.

Sarah can work with manually created sessions and imported recordings without OBS, but OBS is useful when:

- capture timing matters
- telemetry should align with recording start and stop
- multiple camera views are used
- overlays or automated helpers are needed

Linked recordings remain local.

Some formats may be converted into cached preview files for browser or Electron playback while preserving the original source.

---

## Configuration ⚙️

Local runtime configuration is centralized in:

```text
server/config.js
```

Common environment values include:

- `DATABASE_PATH`
- `UPLOAD_DIR`
- `TTS_RENDER_DIR`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_MODEL`
- `OPENAI_TTS_MODEL`
- `OPENAI_TTS_FORMAT`
- `OPENAI_TTS_SPEED`
- `BACKGROUND_JOB_CONCURRENCY`
- `HR_CAPTURE_RELAY_ENABLED`
- `HR_CAPTURE_RELAY_PORT`
- `HR_CAPTURE_WS_URL`
- `OBS_WS_URL`
- `OBS_PASSWORD`
- `HR_RECORDINGS_DIR`
- `EMG_TEXT_DIR`
- `EMG_SESSIONS_DIR`
- `SARAH_VIDEO_DIRS`
- `PULSEPOINT_VIDEO_DIRS`
- `OBS_RECORDINGS_DIR`

Start with `.env.example`. Change only what your setup actually needs.

---

## Privacy and Local Data 🔐

Treat the Sarah workspace as sensitive.

Do not commit:

- `.env`
- raw recordings
- private images or video
- generated narration
- telemetry exports
- local databases
- calibration files
- session CSV files
- temporary processing folders

Important local areas may include:

```text
data/uploads/
data/pulsepoint.sqlite
tools/capture/
```

AI providers receive only the text, audio, or media frames intentionally submitted for a requested operation.

Sarah should never silently convert a local-only workflow into cloud processing.

---

## Development 🛠️

Run the production frontend build:

```bash
npm run build
```

Run lint:

```bash
npm run lint
```

Run type checking:

```bash
npm run typecheck
```

Run local engine tests:

```bash
npm run test:engine
```

Development rules worth keeping:

- prefer focused commits
- protect local-first behavior
- preserve evidence provenance
- avoid unsupported clinical claims
- do not casually alter Sarah’s voice or TTS chunking
- keep changes reversible
- test the workflow you touched

Boring data structures are welcome here.

Working software beats architectural interpretive dance. 💃🔥

---

## Project Status 🚧

Sarah is active and evolving quickly.

The core local application is usable today, while several areas remain under active development:

- AI evidence review
- session analysis
- telemetry integrations
- Motion Lab
- Profiler synthesis
- desktop packaging
- Android and PWA behavior
- voice and narration quality
- broader anatomy and physiology support

Some features are mature.

Some are experimental.

Some are held together by excellent engineering and one emotionally supportive zip tie.

It is what it is. 😄

Contributions, testing, careful bug reports, and evidence-grounded improvements are welcome.
