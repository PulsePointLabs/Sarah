# CIVET 2.2: consistent host-timing gaps and clearer calibration

The plot, sample lookup and offline review used 180 ms while live acquisition
accepted receipt jitter up to 350 ms. This fragmented continuously received data
and repeatedly restarted review filters and event detection. They now share a
350 ms threshold with floating-point tolerance. Explicit gaps, connection/capture
changes and backwards clocks still break the trace. Sample lookup expires after
350 ms, so a real outage does not display an indefinitely frozen last reading.

No pressure samples or timestamps are inserted, removed or moved. This is a
receipt-time tolerance, not proof of lossless delivery. The official protocol
documents nominal 100 ms reports and pressure bytes, but does not document the
apparent clock/counter fields. They are not used to reconstruct timestamps.
https://github.com/dungeonlab-open/dglab-bluetooth-protocol/blob/main/civet-edging-sensor/README.md

Original JSONL and metadata remain unchanged. Algorithm-version/SHA-256 cache
keys generate new replay and review files. Replay records its timing policy and
timestamp-preservation statement. Failed/absent calibration, true long gaps,
pressure shifts and unresolved peak shapes remain visible. Original-live mode
retains the original recorded feature values. Exports retain original clocks.

Calibration is a relative pressure reference, not a maximum-strength test. Rest
is measured after positioning/inflation and stabilization; it is the software
baseline. Hold is a comfortable repeatable five-second squeeze followed by the
existing release check. Hardware zero is still explicitly limited to the
deflated sensor outside the body. No automatic zero or inflation changes occur.

Percent of calibration hold = max(0, pressure minus rest) / hold rise * 100.
100% matches the recorded hold; it is neither maximum muscle strength nor an
arousal score. Numeric values no longer silently saturate at 150%; visual color
and meter fill remain bounded. Invalid references display unavailable.

Validation: synthetic delayed/batched receipt times, real missing intervals,
reconnects, backwards clocks, explicit gaps, replay immutability/determinism,
calibration preservation, actual percentage calculations and existing CIVET
tests. A physical sensor trial remains necessary to validate placement and
physiological interpretation. Fewer flags alone are not proof of accuracy.
