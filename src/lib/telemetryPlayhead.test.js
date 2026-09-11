import test from "node:test";
import assert from "node:assert/strict";
import { telemetryAtOrBefore, telemetryTimeLabel, breakTelemetryGaps } from "./telemetryPlayhead.js";

test("paused telemetry never chooses a richer future packet", () => {
  const rows = [{ time_offset_s: 10, hr: 90 }, { time_offset_s: 10.5, hr: 120, hrv_rmssd_ms: 5 }];
  assert.equal(telemetryAtOrBefore(rows, 10.4).row.hr, 90);
  assert.equal(telemetryAtOrBefore(rows, 10.5).row.hr, 120);
  assert.equal(telemetryAtOrBefore(rows, 9).row, null);
});
test("missing telemetry stays unavailable instead of holding a distant value", () => {
  const rows = [{ time_offset_s: 10, hr: 90 }];
  assert.equal(telemetryAtOrBefore(rows, 12).row.hr, 90);
  assert.equal(telemetryAtOrBefore(rows, 12.001).row, null);
  assert.equal(telemetryAtOrBefore(rows, 15).age, 5);
  assert.equal(telemetryAtOrBefore([], 10).row, null);
});
test("graph gaps are explicit and original samples are preserved", () => {
  const rows = [{ t: 0, hr: 90 }, { t: 1, hr: 92 }, { t: 6, hr: 120 }];
  const result = breakTelemetryGaps(rows, ["hr", "rmssd"]);
  assert.deepEqual(result[2], { t: 3, hr: null, rmssd: null });
  assert.equal(result[3], rows[2]);
  assert.equal(rows.length, 3);
});
test("fractional timing remains visible without rounding to the wrong second", () => {
  assert.equal(telemetryTimeLabel(72.125), "1:12.125");
  assert.equal(telemetryTimeLabel(59.9996), "1:00.000");
});
