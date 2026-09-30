# Continuous session monitoring (v0.1.276)

During an active session, Android's native H10 collector sends received HR/RR and
PMD packets to the desktop independently of the WebView. HRV is calculated on the
server. OMRON acquisition and direct native delivery continue through the shared
foreground capture service introduced in v0.1.275.

The server telemetry snapshot handler now also runs the existing physiology
prediction and CIVET evidence calculation, maintains its rolling history, and
saves physiology-only candidates at detection time. No page, SSE consumer, or
foreground APK is required for this monitoring work. No new device-control
commands are introduced. Prediction thresholds and candidate evidence labels are
preserved; these are review candidates, not confirmed physiological events.

Each sample retains its measurement timestamp. Duplicate, out-of-order, stale,
paused, and interrupted input cannot count as a sustained candidate. Candidate
state advances only after persistence succeeds. Session changes reset history
and load the saved candidate count.

The APK displays the server result. `/api/live-capture/monitoring` exposes current
monitoring status and recent history, and ordinary telemetry SSE snapshots include
the current result. Reopening the screen replaces its potentially suspended SSE
connection and displays already-running server state. This does not initiate
collection or replay data to produce live detections. History shown on return is
the history that the server computed continuously.

The UI labels server monitoring and stops displaying a held watch percentage as
live when samples are stale. Older-server fallback is identified as screen-local.
Install the matching APK to avoid retaining the old screen-owned candidate writer.

Validation includes ten minutes of simulated native HR/RR flowing through the
real decoder with no UI, continuously changing HRV/prediction history, production
snapshot-handler persistence with no connected client, candidate hysteresis,
pause/gap/staleness handling, storage-failure retry, and reconnect rejection of
queued events from an old UI stream. These automated tests do not replace a real
phone test with Howl foregrounded and the screen off. A real network outage cannot
provide live server data; native queues preserve original samples for later delivery.
