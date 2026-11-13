# Live Capture: phone or laptop

The server can stay downstairs. It stores shared sessions and routes commands; it does not need Bluetooth range to sensors acquired by the phone.

## Laptop with Chrome and OBS

1. Open Sarah on the phone and connect CIVET under Devices & Setup → CIVET. The APK uses this phone's Bluetooth by default, including inside full Sarah.
2. Open Sarah in Chrome on the laptop. CIVET pressure follows the phone stream. An explicit phone connection selects it for the shared display too.
3. Open CIVET setup in Chrome or on the phone. Start rest, then Start hold, then release and relax. Chrome sends the request to the phone; it does not create a separate server-only calibration.
4. Use the laptop's OBS cameras for recording. Sensor calibration and bedside monitoring do not require OBS or a recording session.

The updated phone APK must remain running and network-connected for commands from Chrome. Offline phone acquisition continues without the server; Chrome cannot remotely control an unreachable phone.

## Phone by itself

Open standalone phone capture for H10 + CIVET + BP bedside monitoring and local telemetry storage. CIVET connects and calibrates on the phone without a server. The rest of Sarah remains available through Return to Sarah. Phone recording is separate from OBS.

## Calibration controls

- Start rest: three seconds to prepare, then five seconds relaxed.
- Start hold: enabled after an accepted rest; three seconds to prepare, five seconds of a comfortable steady squeeze, then release.
- Start calibration over: available during a running step or settling check.
- Hardware zero: optional, only with CIVET deflated and outside the body. It clears calibration; it is not the normal rest step.
- Missing/stale samples lock measurement and explain why. An old trace is not a live calibration signal.

## Traditional server Bluetooth

Under CIVET setup → Change where CIVET connects, select server Bluetooth only when the sensor is within range of that computer. This choice remains available and survives server restarts. Select phone stream for sensors upstairs; connecting CIVET explicitly in the APK selects that phone stream for the shared display.

The phone keeps raw pressure and calibration events in its private journal. Remote commands are capture-specific, expire quickly, and require a phone acknowledgement. Reopening the phone view replays journaled calibration events, including those requested while its WebView was paused.
