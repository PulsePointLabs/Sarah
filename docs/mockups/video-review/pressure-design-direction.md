# CIVET pressure design direction — October 12, 2026

Ben likes the Pressure review wide/navigator concepts and all three compact card concepts. This is approved visual direction, not approval of a final implementation.

- Pressure review is the proposed replacement for the pressure **Inspect** dialog's train-button/statistics/data-dump presentation. It is not a redesign of the app's general Insights area.
- Keep Balanced, Waveform first, and Burst review available through an easy selector on the Video Sync sidebar card.
- Live Capture Full Telemetry needs its own monitoring presentation, legible across the room: prominent numbers and state, clear waveform, few supporting values, obvious missing/uncertain states.
- Mockups only for now. Preserve production code, algorithms, recordings, calibration, settings, and exports.
- All new preview data is illustrative and synthetic. Mechanical pressure and calibrated relative pressure remain distinct; no inferred orgasm label or invented data across gaps.

Live preview: `../live-pressure/live-pressure.html`. Three layouts with selectable sustained hold, repeated pulses, uncertain-reference, and missing-signal states. These illustrate future controls and visual hierarchy, not working device integration.

## Refined Live Capture scope

Ben likes the three live pressure designs provided they can switch directly on the card. Replace only the existing Live Capture pelvic-pressure metric card/graph, rather than redesigning the Full Telemetry dashboard. Remove redundant labels such as "live recording" and reduce excess padding, balancing graph space and large, across-room-readable numbers.

Explore automatic time-window zoom for strong or rhythmic contractions with a stable, clearly labelled pressure scale; avoid confusing zoom changes, noise-triggered zoom, and constantly jumping windows. Keep manual zoom override. Proposed trigger/release behavior needs validation before implementation.

Refined, card-only interactive mockups: `../live-pressure/card-replacement.html`. All samples are synthetic. Production app is unchanged.

Ben particularly likes Balanced and its adaptive sustained/strong/rhythmic presentation with auto zoom. New requested exploration: glanceable live pressure, average, maximum, current contraction duration, and feedback on progression through the session. Clearly label averaging/maximum time windows. Distinguish an ongoing hold timer from the duration of a last completed pulse; do not imply a contraction is ongoing between rhythmic pulses. Mockups: `../live-pressure/balanced-progression.html`, with four-reading, live-and-timer-focused, and recent-versus-session layouts. No production changes.
