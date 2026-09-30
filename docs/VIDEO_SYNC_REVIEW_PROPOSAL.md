# Video Sync review redesign — proposed, not deployed

Requested by Ben, 2026-09-28. Review these concepts before implementation.

Status, 2026-09-30: the broader sidebar layouts below remain proposals. Numpad speed shortcuts, stacked/side-by-side camera views (including dual monitors), and a default reprocessed CIVET view with original-live comparison have been implemented. Reprocessing restores reference metrics only after a recorded verified calibration; the initial recording's unverified calibration is not automatically repaired. The pressure-burst inspector redesign and local-pressure-change plot remain pending.

## First CIVET session recovery

Preserve original JSONL, timestamps, calibration events and raw packet evidence. Generate a separately versioned reconstructed review with the original file hash and acquisition policy. Retain the original recorded-live view as an explicit comparison, not the default misleading zero-pulse display. Recover pressure peak candidates and intervals where samples support them; do not invent missing samples, absolute force, or trusted reference intensity where calibration remains uncertain. Show a short provenance badge: Reprocessed / Reference uncertain, with details on click. Do not change manual markers or trigger AI jobs.

## Conservative sidebar refinements

- Actual metric and trend components are reused in the concepts. Demo values and the illustrative six-peak burst are synthetic, not conclusions about Ben's recording. Private video is intentionally absent.
- Move graph-window selector, channel toggles and voice settings into playback controls. Channels and voice open compact popovers only when needed.
- Keep the full Build/Plateau/Recovery card, including scores, curves and expandable evidence. Compare modest spacing reductions and a wider sidebar; do not replace the card with a state strip. Remove only the Color cue toggle. Preserve existing card order and the video area.
- Keep vitals on one row. Reserve text slots; no layout changes when values or status text change.
- Pelvic pressure: large pressure/relative intensity when valid, peaks in the viewed burst/window, and duration. Give most space to a readable waveform. A short status badge opens the reason and timing; no repeated warning sentence on every graph.
- Rename trains to pressure bursts in review. Only show the selected interval and nearby bursts. Previous/next and Play interval navigate video. Show peak markers, count, duration and spacing. Technical tags/JSON/exports belong in a collapsed Advanced section.
- Bound horizontal resize using content-aware readable minimum widths; no nested auto-fit wrapping or hidden mode switch. Clamp the divider, retain whole-frame video, and offer double-click reset. Do not crop video.
- Vertical dividers redistribute adjacent section space with visible handles and readable minima. All enabled graphs stay visible; no sidebar scrolling, tab fallback, or silent font shrink. If the viewport cannot physically fit all selected channels, clearly offer a wider sidebar, focused layout or deselecting a channel rather than silently hiding content.

## Keyboard requirement — do not omit

Numpad1 through Numpad9 set playback to 1x through 9x. Use event.code, ignore inputs/textareas/contenteditable and modifier shortcuts, preserve existing N/C event markers and other playback keys. Show the mapping beside the speed picker/help. Final 0/+/- behavior can be chosen later; not required for the proposed 1–9 mapping.

## Preview files (latest A/B/C supersede the earlier overall layouts)

- scripts/tests/fixtures/video-sidebar-refinements.html: latest isolated React previews using existing components and synthetic values; no production route edits.
- docs/mockups/video-review/sidebar-refinements.png and sidebar-a.png, sidebar-b.png, sidebar-c.png
- Earlier pressure card and inspector concepts remain approved overall.
- docs/mockups/video-review/balanced.png
- docs/mockups/video-review/pressure.png
- docs/mockups/video-review/inspector.png

Next implementation checks: original-session reanalysis remains separate and reproducible; no false zeros when confidence is missing; exact video/telemetry alignment through trim and offsets; resize at common monitor sizes; no hidden graphs or scrolling; keyboard tests; no automatic near-climax AI review.

Important plot correction: the current CivetPlot includes zero in its vertical domain, compressing changes on an inflated resting pressure around 22 kPa. The review should default to a clearly labeled local-pressure-change trace with an appropriate vertical range. Raw absolute pressure remains available. Local rest estimation is a display/analysis reference, not recovered calibration or absolute muscle force.
