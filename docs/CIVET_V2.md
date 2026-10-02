# CIVET morphology v2

Current timing and calibration display changes: [CIVET 2.2](CIVET_TIMING_2_2.md).
The 180 ms gap rule below describes historical 2.0 behavior and is superseded by
the shared 350 ms host-receipt policy.

## Setup

Connect CIVET → Scan → select device → Connect. Windows records independently of browser visibility. The sensor must be within Bluetooth range. Five power-button presses make its Bluetooth icon yellow/discoverable.

Optional before insertion: confirm CIVET is fully deflated and outside the body, then **Zero CIVET while deflated**. In recording position, collect a five-second relaxed baseline and five-second held reference contraction. Recalibrate after repositioning. Start the Sarah session normally.

Official protocol: https://github.com/dungeonlab-open/dglab-bluetooth-protocol/blob/main/civet-edging-sensor/README.md

Zero writes the exact published example `66000000000000000000000002` to 150A. It is **13 bytes**, despite the document calling it 12 bytes. No padding is guessed. A completed BLE write is logged, not an independently verified physical zero. Failure, timeout and disconnect are visible. Zero is never automatic, invalidates calibration, and its timestamp is associated with the current/next session for the same Bluetooth address. No actuator commands were added.

## Preservation and calibration

The original v1 transport was retained; its threshold detector was inadequate for repeated peaks on elevated tonic pressure. V2 records unchanged pressure, signed integer, exact packet hex, sequence, connection/capture identity, monotonic host time, anchored UTC and session-relative time. The protocol reports about 10 samples/s. Receipt timestamps are not device acquisition timestamps; 0.01 kPa encoding is not an accuracy specification.

Intervals >0.18s, non-increasing times and reconnects are explicit gaps. Nothing is interpolated. Host scheduling/batching may trigger quality flags. Calibration boundaries split analysis too.

Baseline stores mean, variance, SD, endpoint drift, timestamp and ID. Fewer than 45 samples in five seconds, missing packets, SD >0.12 kPa or drift >0.15 kPa fail calibration. Reference is the 95th percentile minus baseline, must exceed max(0.1 kPa, 6 baseline SD), and its 25th percentile must remain above 30% of reference. These are engineering gates pending physical validation, not physiological norms. Each recalibration gets a new ID; historical rows remain untouched.

Reconnect, suspicious persistent pressure steps or baseline drift withhold normalization until recalibration. Returning to baseline after reference calibration is not a placement failure. Pressure remains visible while normalization is withheld.

## Algorithms

Version: `civet-morphology-2.0.0`.

Local peak/trough direction changes use prominence max(0.05 kPa, 4 baseline SD, 4% reference). Nominal minimum separation is 0.4s. Closer candidates and one-sample rise/fall events remain reviewable with uncertainty flags, excluded from clean live evidence.

Events record onset/peak/end/trough, later confirmation time, amplitude/prominence, raw amplitude/prominence, rise/fall/duration, preceding/following interval, tonic pressure, calibration and flags. Timing uses observed samples, approximately 0.1s; no interpolated precision is claimed.

- **Live causal:** identity pressure filter preserves peak timing; prominence suppresses small fluctuations. Tonic is a causal 3s exponential estimate (with lag), phasic is pressure minus tonic. Events are saved when a falling shoulder and settled/rising trough confirm them. Playback does not draw live peaks before confirmation.
- **Review:** symmetric 1:2:1 three-sample smoothing and centered five-second 20th-percentile tonic estimate. No filtering across gaps/calibration boundaries. Edges are flagged. Narrow peaks may attenuate; raw pressure and raw amplitudes remain separately available. Review cannot contribute to live phase evidence and never overwrites recorded features or announcements.

At least three events separated by 0.4–3s form a train. Summaries include all peaks, first/last peak, onset-to-end duration, intervals and SD/CV, individual and mean/median/max amplitudes/prominences, amplitude slope, durations/rise/fall, and tonic before/during/after. Missing windows remain null. Gaps/calibration changes split trains. Questionable events retain train-level flags.

Pressure cannot determine whether a change came from movement, tubing compression, repositioning or orgasm. Flags describe abrupt/impulsive changes, persistent steps, drift, gaps and unresolved morphology. Tonic elevation may be physiological too; events remain available while normalized comparison is withheld. Rhythm requires three clean recent events, mean interval ≤3s and CV <0.35. CIVET retains the bounded 4/8-point contribution and shared EMG muscular-evidence budget. Howl controller inputs remain unchanged.

## Storage, review and export

Original `data/civet/<session>.jsonl` files are never rewritten by review. Metadata JSONL records calibration/zero history. Review JSON is keyed by algorithm version and raw-file SHA-256 and stores parameters. Corrupt rows raise a visible error rather than disappearing silently. V1 recordings retain their recorded live features; v2 review morphology is separate. No-CIVET sessions remain empty/hidden. Windows packaging now includes the helper.

Use **Inspect** on a CIVET card. Choose raw/filtered/tonic/phasic/event layers, recorded-live or retrospective analysis, and a train. Clicking peaks/event rows uses Video Sync's existing seek callback and common session-relative clock. Manual climax markers are displayed where supplied. Detailed review opens separately, preserving the fitted, non-scrolling sidebar. Color means relative pressure, not muscle force.

`GET /api/civet/session/:id` returns original samples and analysis. Review is generated after recording ends. Export suffixes:

- `/export` or `?kind=samples`: original sample CSV, retaining existing columns and appending provenance/quality.
- `?kind=events&mode=live|review`: one event per CSV row.
- `?kind=trains&mode=live|review`: one train per CSV row.
- `?kind=analysis&mode=live|review`: complete JSON with per-sample review layers, metadata and parameters.

All derived metrics are available in inspector details or complete JSON. CSV escapes nested calibration/flag JSON correctly. No cloud upload is involved.

## Validation boundary

Synthetic tests cover isolated/rhythmic contractions, tonic elevation, increasing/decreasing amplitudes, noise/flat signals, drift, steps, impulses, single missing packets/long gaps, reconnect, unstable/weak calibration, recalibration, 0.4s spacing, train boundaries, raw preservation, legacy files, reproducible caches, CSV escaping and simulated zero success/failure/disconnect. Python tests cover official positive/negative decoding, malformed packets and exact zero bytes. Browser checks cover layers, event seeking, desktop/mobile inspection and the no-scroll Video Sync sidebar.

Still needs the physical sensor: Windows cadence/latency under load, firmware zero behavior (including the manufacturer's length inconsistency), calibration repeatability, tubing/placement effects, real contractions against synchronized video/manual markers, and EMG comparisons. Synthetic correctness does not validate orgasm classification or sensor accuracy.

## Distance-readable calibration panel

Setup uses a single **Zero — deflated & outside body** button; clicking explicitly confirms those conditions. Hardware-zero transport and acknowledgement remain unchanged.

**Start rest** and **Start hold** each allow three seconds to prepare before five seconds of sampled measurement. Both countdowns are driven by received sensor time, so a frozen or disconnected feed cannot silently complete calibration. Large text, pressure trace, and green/amber feedback show stability; they cannot identify the source of pressure changes. Failed holds can be retried against the accepted baseline unless a gap, reconnect, or placement change invalidates it.

Calibration policy `pressure-stability-1` retains the existing missing-sample, baseline SD/drift, and reference amplitude gates. It additionally rejects rest excursions over 0.3 kPa. Holds are rejected for SD over max(0.12 kPa, 20% reference), endpoint drift over max(0.15 kPa, 30% reference), or total range over max(0.3 kPa, 65% reference). These engineering thresholds still need physical calibration validation. Failed calibration is withheld from normalized pressure and live phase evidence. Earlier recordings are unchanged.

## Live acquisition policy pressure-acquisition-2

Live Capture now checks that pressure returns to a stable resting range after the five-second reference hold. It needs approximately three seconds of stable received samples, with a maximum 30-second settling wait. It never silently rewrites the measured baseline. Rest tolerance is max(0.5 kPa, 20% reference amplitude, 8 baseline SD); the wider tolerance addresses the recorded post-hold settling failure without claiming physiological validation.

Brief gaps break peak detection and temporarily withhold reference intensity for two seconds of fresh signal. Reconnects, non-forward timestamps, and gaps over two seconds require deliberate calibration. A sustained eight-second pressure floor outside the resting tolerance (or above baseline by max(1 kPa, 80% reference)) starts a visible checking state; persistence for ten more seconds prompts recalibration. Three seconds of restored window conditions recover automatically. Elevated pressure can be a real hold; the message describes uncertainty, not a proven displacement.

Pressure-peak shape quality is independent of the relative-intensity reference. Events retain their true calibration_valid and reference_quality fields plus pressure_only:true. Missing samples, abrupt pressure changes, and under-resolved peaks still reduce event quality; uncertainty is not silently counted as a clean peak. Live phase evidence still requires a valid settled reference. Raw sample values and timestamps remain unchanged. Acquisition transitions and sensor connection transitions are recorded in session metadata. Existing recording files and Video Sync presentation are not rewritten.

The Live Capture-only monitor has large text, relative-pressure color and bar, a hold timer/bar (bar full at ten seconds), pulse count, pressure trend, and an expanded monitor. Small tiles prioritize current intensity (or raw pressure if uncalibrated), hold and count; expand for the trend. The warning banner persists through an issue, with one spoken generic alert after three seconds, shared through the existing Sarah cue-audio system. Browser audio must be enabled by a user gesture; the banner reports sound readiness and provides Enable / test sound and mute. Only the fixed sensor-attention phrase goes to the configured speech provider, not pressure samples.

Validation includes the previously failing recording replayed without modifying its bytes, synthetic settling/drift/gap/reconnect tests, and browser calibration/monitor size checks. Thresholds remain engineering choices pending additional physical-device sessions.
