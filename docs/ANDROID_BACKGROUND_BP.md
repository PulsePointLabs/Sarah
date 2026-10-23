# Android cuff capture and late H10 delivery

Sarah v0.1.275 moves OMRON BLE ownership out of the Capacitor screen plugin and
into an application collector restored by the existing connected-device foreground
service. Arming the cuff starts that service; destroying the activity no longer
disarms the cuff. Explicit Stop still disarms it. H10 and OMRON each keep the shared
service alive while enabled.

Received cuff measurements are persisted before notifying the screen. A native
worker delivers queued measurements to the configured Sarah `/blood-pressure/ingest`
endpoint every three seconds, independently of JavaScript. Failed deliveries stay
queued, and removal requires a successful response naming that exact external ID.
Foreground delivery remains compatible and the server deduplicates concurrent retries.
Nothing is uploaded to a new service.

The cuff is reported as subscribed only after successful indication-descriptor
acknowledgment. Connection/discovery timeouts and failed scans retry. This follows
[Android's background BLE guidance](https://developer.android.com/develop/connectivity/bluetooth/ble/background)
for a connected-device foreground service started while the app is visible.

### Cuff setup versus a Bluetooth connection (v0.1.292)

A successful subscription, or the cuff displaying OK after a transfer, does not
prove that cuff-side pairing/setup is complete. Before enabling BP indications,
Sarah checks the advertised standard Current Time service (1805/2A2B). If its
clock is invalid or differs from the phone by more than three minutes, Sarah
writes the phone's local time only when the characteristic advertises acknowledged
writes, then reads it back when supported. Unsupported, rejected, or timed-out
clock operations fall back to receiving readings with an explicit setup warning.
Clock verification is never labeled as proof of device-side pairing. Old packets
retain their original timestamp provenance; clock setup only affects future readings.

Live Capture's telemetry Controls include Copy cuff diagnostics. The copied report
contains connection/clock result codes, OS bond state, delivery-pending/count flags,
and the last 20 connection events retained on the phone. It excludes BP values,
device addresses and server URLs. Native callbacks and polling both refresh this
status, so a resumed WebView does not replace a setup warning with generic readiness.

If the cuff still says Please pair, stop Sarah's listener before pairing and syncing
in OMRON Connect. Test one measurement while Sarah remains stopped to distinguish
cuff setup from a Sarah reconnection problem. Do not clear cuff memory, Android app
data, or saved readings as a troubleshooting shortcut.

H10 already has native acquisition and native delivery. The recording writer now
accepts delayed native samples with their original measurement timestamps, deduplicates
timestamps, and permits retry after disk-write failure. Review imports sort those
rows and rebuild the rolling HRV window from ordered RR intervals when buffered
delivery occurred. Non-native live timestamp ordering stays unchanged.

For an existing session, `node scripts/recover-buffered-h10.mjs SESSION_ID` reports
recoverable original native packets. `--apply` backs up affected review records to
local ignored logs before adding packets and recalculating affected HRV values.
Original CSVs and native packet receipts remain unchanged. Modified review records
retain original live HRV values; recovered rows identify the source packet. This
tool does not invent missing ECG, movement, or derived phase values.

Validation: BP ingestion/retry tests, native H10 decoder tests, late-packet writer
tests, chronological HRV tests, recovery dry-run/idempotence tests, lint, Kotlin
compilation, Android unit-test task, and release artifact checks. Android unit tests
do not exercise physical Bluetooth. A real phone test must still cover Sarah → Howl,
screen off, cuff measurement, return to Sarah, and a temporary server outage.

Build/near-climax UI history restoration was not changed in v0.1.275. v0.1.276 adds
continuous server monitoring; see [Live server monitoring](LIVE_SERVER_MONITORING.md).
