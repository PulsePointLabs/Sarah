# Perineal Body EMG MVP QA

Manual checklist:

1. Start the PulsePoint server and EMG helper.
2. Open Live Capture and start or attach to an active recording.
3. Select `Perineal Body EMG` in EMG Sensor Configuration.
4. Confirm the EMG feed shows a recent live signal.
5. Open `Perineal Body EMG Reference Capture`.
6. Press `Start Perineal EMG Test Protocol`.
7. Follow the phases: relaxed baseline, five light Kegels, five strong Kegels, one long hold, cough, glute squeeze, thigh/adductor squeeze, final relaxed baseline.
8. Confirm timeline markers are created for protocol phase start/end.
9. Confirm detected contractions create session events with `source: perineal_emg`.
10. Save/finalize the session, refresh Session Details, and confirm the markers persist in the event timeline.
11. Generate Sarah analysis and confirm detected perineal EMG events are described only when detector events exist.

Known MVP limits:

- Surface EMG cannot perfectly separate pelvic-floor activation from glute/adductor/cough artifact.
- Artifact checks are stored as caution references, not a full classifier.
- Detector thresholds depend on stable electrode contact and a usable relaxed baseline.
- Automatic detection only runs in Live Capture while `Perineal Body EMG` mode is active.
