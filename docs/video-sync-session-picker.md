# Video Sync session overview

The picker follows the app theme, including its portaled dropdown. Dates and times use separate header badges; duration, linked videos, events and marked episodes use footer badges. Recorded devices and telemetry snapshots appear between them. Numeric SQLite flags are normalized before rendering so false flags cannot appear as stray `0` text.

HR summaries use recorded timeline samples between 20 and 260 bpm; stored summary values are the fallback when no timeline is present. Pressure summaries stream the original CIVET recording without running morphology analysis: usable samples are preferred, and raw-only summaries are explicitly labeled. Outcome badges use saved climax markers/duration and subjective episode markings, never AI probability. Missing outcome data remains unknown. Enabling a sensor alone does not establish recorded use.

The summary service uses a worker thread to keep parsing and SQL aggregation out of the acquisition event loop. `POST /api/session-video/review-summaries` accepts up to 200 `{entity,id}` entries and returns lightweight summaries, with a one-minute cache. A server restart is required to load this new route.

Existing records can retain a derived `review_snapshot` for compatibility with older running servers and offline display. `node scripts/backfill-video-review-snapshots.mjs` audits; adding `--write` populates the cache with a local restore export. It does not alter notes, raw telemetry, update timestamps or session ordering. The UI can display cached summaries before the new route is loaded.
