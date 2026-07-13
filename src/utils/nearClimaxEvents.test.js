import test from "node:test";
import assert from "node:assert/strict";
import { detectNearClimaxEvents } from "./nearClimaxEvents.js";

function sessionRow(time, hr, rmssd, quality = "high") {
  return {
    time_offset_s: time,
    hr,
    hrv_rmssd_ms: rmssd,
    hrv_quality: quality,
  };
}

function buildFixtureRows() {
  const rows = [];
  for (let t = 0; t <= 2600; t += 10) {
    let hr = 84 + (t / 2600) * 10;
    let rmssd = 11 - Math.min(3, t / 1200);

    if (t >= 220 && t <= 330) {
      const shape = [86, 88, 90, 92, 93, 92, 90, 88, 87, 86, 85, 84];
      hr = shape[Math.floor((t - 220) / 10)] ?? hr;
      rmssd = 10.5;
    }

    if (t >= 1380 && t <= 1520) {
      const shape = [97, 100, 104, 108, 112, 114, 114, 113, 112, 110, 108, 106, 104, 102, 100];
      hr = shape[Math.floor((t - 1380) / 10)] ?? hr;
      rmssd = 4.4;
    }

    if (t >= 2100 && t <= 2240) {
      const shape = [101, 104, 108, 112, 115, 117, 117, 116, 115, 113, 111, 109, 107, 105, 103];
      hr = shape[Math.floor((t - 2100) / 10)] ?? hr;
      rmssd = 3.6;
    }

    if (t >= 2440 && t <= 2560) {
      const shape = [110, 113, 116, 119, 121, 122, 121, 120, 118, 116, 114, 112, 110];
      hr = shape[Math.floor((t - 2440) / 10)] ?? hr;
      rmssd = 2.4;
    }

    rows.push(sessionRow(t, hr, rmssd, "high"));
  }
  return rows;
}

test("near-climax detector suppresses early low-HR noise and keeps later compressed plateau events", () => {
  const rows = buildFixtureRows();
  const sessionEvents = [
    { time_s: 1450, note: "feet planted with pressure building fast", category: ["physical"] },
    { time_s: 2180, note: "strong tremble and surge with breath hold", category: ["physical"] },
  ];

  const events = detectNearClimaxEvents(rows, 2660, 2580, sessionEvents);

  assert.equal(events.some((event) => event.start_offset_s < 8 * 60), false);
  assert.equal(events.some((event) => event.start_offset_s >= 1360 && event.start_offset_s <= 1420), true);
  assert.equal(events.some((event) => event.start_offset_s >= 2080 && event.start_offset_s <= 2140), true);
});
