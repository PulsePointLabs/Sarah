# Phone acquisition and bedside monitoring

The Android APK opens the full Sarah app with its normal navigation. The local
monitor is an explicit **Open standalone phone capture** option inside Live
Capture, and **Open Phone Capture** remains an
explicit fallback on the connection/login screen. No OBS recording,
Sarah server, or active session is required to acquire and display these sensors:

| Sensor | Phone acquisition | Local data |
| --- | --- | --- |
| Polar H10 | Native HR/RR and supported PMD ECG/motion | Original HR packets plus PMD frames |
| OMRON BP7000 | Native BLE indications | Original reading and timestamp provenance |
| CIVET | Native pressure notifications and explicit commands | Raw packets, receive/monotonic time, sequence, connection and calibration events |

Choose **Devices & Setup** to connect sensors. CIVET must be powered on and
discoverable. Its setup distinguishes a Bluetooth connection from actual fresh
pressure. Collect rest and a comfortable reference hold on the acquiring phone.
**Return to Sarah** restores normal navigation and the server-connected Live
Capture view. Being an Android app does not automatically select phone acquisition.
Already enabled native collectors retain their background acquisition and data.

After measuring BP, press the cuff's transfer button if it has gone idle. Pairing,
listening, receipt, a local save, and a server copy are separate facts. Invalid
historical cuff dates remain preserved and unassigned; they are not relabeled as
today's measurements. A stopped listener remains stopped until enabled again.

Acquisition runs in the existing Android foreground capture service. Private
`telemetry_journal.db` retains original packets even after a server acknowledgement.
H10/BP use their durable delivery queues; CIVET copies its ordered journal with a
durable server cursor. Failed server copies do not stop local acquisition. The
server archives backfill without presenting old timestamps as fresh telemetry.
Native monitor HR and pressure come from this phone, rather than another client's
server stream. Reconnects and missing data invalidate uncertain pressure features.

**Export phone telemetry** writes JSONL to `Downloads/Sarah`. It is a local export;
there is no cloud upload. Exports contain private sensor data. Install updates over
the existing APK: uninstalling removes Android's private app data.

**Bedside monitor → Full screen** uses Android system-bar controls for this APK,
not the browser's arbitrary-element fullscreen API. Back exits immersive mode;
the on-screen exit and sensor controls remain accessible.

## Current boundary

Arduino EMG still uses the computer USB/Python helper. This build does not acquire
Arduino serial data over phone USB. Windows/Chrome continue to support that path.
Local sensor journals are not yet a complete replacement for server session review,
AI analysis, or video synchronization. CIVET pressure and calibration copies are
available on the server while connected; recording/review uses the server's existing
session workflow. Raw standalone monitoring remains exportable on the phone.

Software tests do not establish a fresh physical cuff or CIVET transfer. Release
notes must report installed-device tests separately from real sensor verification.
