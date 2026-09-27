# CIVET monitoring (historical v1)

For the current implementation, see [CIVET v2 acquisition, analysis and validation](CIVET_V2.md). The text below describes the original threshold detector.

Live Capture: Connect CIVET -> Scan -> select sensor -> Connect. This Windows host has the helper installed; elsewhere use Install helper once. CIVET must be within Bluetooth range of the desktop. If it is not discoverable, press its power button five times until the Bluetooth icon is yellow. Close other apps that hold its Bluetooth connection.

In recording position, capture five seconds relaxed baseline, then five seconds of a comfortable reference contraction. Repeat after repositioning. The current pressure remains visible before calibration; normalized response and phase contributions require calibration. No automatic device-zero commands are sent.

Start the Sarah session normally. The desktop records every received pressure sample to data/civet/<session-id>.jsonl, independently of browser visibility. This is about 10 samples/second under the published protocol. Timestamps are anchored to a monotonic clock. Disconnect gaps remain gaps and reconnection is automatic while the helper runs. Restarting Sarah requires reconnecting and recalibrating; existing session files remain recoverable.

The optional CIVET card shows baseline-relative kPa, percent of the reference contraction, 30-second average/peak, pulses in the last 60 seconds, and current hold duration. The background moves from teal toward amber/red with relative pressure; this is not a calibrated muscle-force scale. Suspected placement drift with pressure below baseline disables normalized evidence until stable/recalibrated. Movement and external pressure can still mimic contractions.

Session Details and Body Exploration Details show recorded CIVET only when samples exist, including session summary, time slider and CSV export. Video Sync offers a CIVET toggle and follows its session playhead. The recorded causal features drive the same colors in live and playback. A rhythmic contraction candidate requires at least three recent detected pulses with similar intervals. Neither that label nor the phase watch confirms climax.

CIVET adds a bounded supporting contribution to the monitoring phase score only after existing cardiac build gates are satisfied. EMG and CIVET share a muscular contribution budget in the live display. Existing Howl controller inputs are intentionally unchanged; CIVET has no actuator-control path. Playback uses the existing separate review heuristic, with the same CIVET event features. Historical sessions lacking CIVET are unchanged.

Validation: synthetic physiological traces, file recording/reopen tests, official BLE decoding examples, browser card/layout and setup-error checks. Physical Bluetooth reception and biological response still need verification with the actual sensor.
