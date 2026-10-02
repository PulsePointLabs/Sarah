# EMG guided setup in Sarah 0.1.278

Live Capture has matching Pelvic pressure and EMG setup buttons. EMG setup uses
the same large modal, preparation/measurement countdown, release feedback and
button styling as CIVET. Names are visible fields, shared on the Windows server
with placement notes. The selected port is remembered; reconnects during this
Sarah run match Arduino USB identity when supplied, otherwise the selected port
and VID/PID. Disconnect cancels retries. Restarting the helper requires fresh
calibration rather than silently trusting moved electrodes.

Three separate indicators show dependency installation, collector process state
and actual fresh samples. Install/repair provisions the existing dedicated Python
environment; Python itself remains a prerequisite. No terminal is needed for
normal use. Copy Arduino code supplies a 100 Hz A0,A1 ENV sketch for 10-bit ADC
boards such as Uno/Nano at 115200 baud. Clipboard failure exposes selectable code.

## Calibration and interpretation

Measurements execute in Python, independent of the browser or phone foreground:
three seconds preparation, five seconds measured rest, five seconds per channel
hold and a two-second return near rest (up to 30 seconds allowed). All selected
channels must pass before Save. A gap over 500 ms, too few samples, ADC-limit
values, unstable rest, inadequate rise or inconsistent hold rejects the step.
These are engineering quality gates, not validated muscle-specific norms.

100% now means the measured ENV rise above rest matches the comfortable hold.
New guided calibrations use headroom 1.0; old calibration files/recordings retain
their original scale. Both numerical overlays permit values beyond the former
150% cap in the new scale. ENV is already a sensor envelope, not raw broadband
EMG; frequency-domain fatigue analysis and muscle-isolation claims are unsupported.

During invalid/unfinished managed calibration, live normalized values are
unavailable; CSV preserves raw/envelope values but leaves percentages empty.
CSV column names are retained and validity/phase columns appended. Each new CSV
has a metadata sidecar with names, placement notes, channel mapping and initial
calibration. Active Sarah sessions also snapshot the channel profile. Existing
CSV recording still follows primary OBS. This does not migrate the separate,
browser-operated perineal test protocol or its perineal event-marker workflow.

## Stability and validation

Serial framing retains partial lines and rejects malformed/nonfinite/out-of-range
readings, rather than interpreting a partial number as a full sample. The helper
still prioritizes the newest envelope reading when draining a backlog; it does
not claim to archive every Arduino ADC sample. Windows status-file replacement
retries transient reader locks; an old complete status remains available.
Stale percentages expire instead of being displayed indefinitely or contributing
fresh evidence to server monitoring. Calibration progress and fresh sensor data
are separately timestamped.

Tests cover measured calibration and failures, both real helper loops with
simulated serial input and no browser, 100% normalization after save, partial
frames, server profiles/status/reconnection, production freshness handling,
and desktop/phone modal behavior with clipboard copying. Physical Arduino and
electrode validation remains necessary. Check rest, separate channel holds,
release, cable movement, and unplug/replug before relying on a full recording.
