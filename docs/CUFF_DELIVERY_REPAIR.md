# Cuff delivery repair - v0.1.298

The November 3 reading was already on the server at the time of phone receipt.
Its cuff-clock measurement timestamp was almost one hour in the future. This
explains why strict session membership rejected it; it does not establish the
cause of every prior delivery warning. No phone is attached for live inspection.

The Android collector now checks Current Time read-only after enabling BP
indications. A verified current one-hour clock mismatch is corrected on incoming
measurement timestamps. It retains the original cuff timestamp, observed offset,
and stable original external ID. Unknown dates and unrelated clock errors are
not guessed; stored old measurements remain old. The clock check is bounded to
one second, never writes to the cuff, and never initiates pairing.

Fresh readings appear before server upload completes, labeled as saving until
confirmed. Failed requests have a timeout and rediscover the reachable existing
Sarah backend; the native uploader follows the recovered endpoint without BLE
reconnection. Native delivery starts immediately on receipt and clears stale
errors on acknowledgement. Session-attachment failures remain retryable.
Clipboard diagnostics expose only sanitized delivery error categories.

Validation uses isolated databases and synthetic packets. Both Session and
BodyExploration retain deduplication and recording/pause boundaries. No existing
private readings are retimed, no cuff pairing state is reset, and no physical
Bluetooth run has been claimed from software tests.
