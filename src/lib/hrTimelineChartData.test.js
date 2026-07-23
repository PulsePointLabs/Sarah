import test from "node:test";
import assert from "node:assert/strict";
import { buildCleanChartRows } from "./hrTimelineChartData.js";

test("removes unavailable zero placeholders without dropping valid HR samples", () => {
  const rows = buildCleanChartRows([
    {
      time_offset_s: 1,
      hr: 86,
      hr_smoothed: 0,
      baseline_hr: 0,
      hrv_rmssd_ms: 0,
      hrv_sdnn_ms: 0,
      hrv_pnn50: 0,
      marker: "build",
    },
    {
      time_offset_s: 2,
      hr: 87,
      hr_smoothed: 86.5,
      baseline_hr: 82,
      hrv_rmssd_ms: 24.2,
      hrv_sdnn_ms: 31.7,
      hrv_pnn50: 0,
    },
  ]);

  assert.deepEqual(rows[0], {
    time_offset_s: 1,
    hr: 86,
    hr_smoothed: null,
    baseline_hr: null,
    elevated_delta: null,
    hrv_rmssd_ms: null,
    hrv_sdnn_ms: null,
    hrv_pnn50: 0,
    marker: "build",
    note: null,
    hrv_quality: null,
  });
  assert.equal(rows[1].hr, 87);
  assert.equal(rows[1].hr_smoothed, 86.5);
  assert.equal(rows[1].hrv_rmssd_ms, 24.2);
});

test("averages duplicate timestamps while ignoring placeholder zeros", () => {
  const [row] = buildCleanChartRows([
    { time_offset_s: 4, hr: 90, hr_smoothed: 0, hrv_rmssd_ms: 0 },
    { time_offset_s: 4, hr: 92, hr_smoothed: 91, hrv_rmssd_ms: 18 },
  ]);

  assert.equal(row.hr, 91);
  assert.equal(row.hr_smoothed, 91);
  assert.equal(row.hrv_rmssd_ms, 18);
});
