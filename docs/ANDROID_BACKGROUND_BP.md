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

### Cuff connection recovery and simple controls (v0.1.295)

The transport returns to the pre-v0.1.292 indication-only flow: service discovery,
BP indication subscription, then measurement callbacks. There are no Current Time
reads or writes. The clock checks added in v0.1.292 and made read-only in v0.1.294
produced confusing setup warnings; they are not part of the cuff connection flow.
The actual stored readings show successful native deliveries during the reported
clock-write warning sequence. A warning was not evidence of a failed BP transfer.

Live Capture presents Connect cuff / Disconnect cuff and the actual connection or
save status. Change cuff and Copy technical details sit under Cuff options.
A reading received since opening Live Capture is shown even without a recording,
explicitly saved to BP history. Historical replays do not appear as fresh readings.
Only exact measurement/session membership can populate the session telemetry card.
Unknown, stale, paused, pre-session and post-session timestamps remain history-only.

Native reattachment keeps its existing collector. Disconnect releases native BLE
even after JavaScript loses its listener handle; queued readings remain saved.
The durable uploader and exact-ID acknowledgement are unchanged. Diagnostics are
available on request, not a required user workflow. A physical phone/cuff trial is
still required; browser and protocol tests do not demonstrate radio behavior.

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
