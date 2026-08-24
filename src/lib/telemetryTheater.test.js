import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTimedReadings, readingOffsetSeconds, readingSequenceAt } from "./telemetryTheater.js";

test("uses a saved session offset before deriving one from timestamps", () => {
  assert.equal(readingOffsetSeconds({ time_offset_s: 42, measured_at: "2026-08-23T20:15:00" }, {
    date: "2026-08-23",
    start_time: "20:00",
  }), 42);
});

test("maps absolute vital timestamps onto the session clock", () => {
  assert.equal(readingOffsetSeconds({ measured_at: "2026-08-23T20:02:30" }, {
    date: "2026-08-23",
    start_time: "20:00",
  }), 150);
});

test("returns previous and upcoming readings around the playhead", () => {
  const readings = normalizeTimedReadings([
    { id: "later", time_offset_s: 300 },
    { id: "earlier", time_offset_s: -60 },
    { id: "middle", time_offset_s: 120 },
  ]);
  const sequence = readingSequenceAt(readings, 150);
  assert.equal(sequence.previous.id, "middle");
  assert.equal(sequence.upcoming.id, "later");
  assert.equal(sequence.nearest.id, "middle");
});
