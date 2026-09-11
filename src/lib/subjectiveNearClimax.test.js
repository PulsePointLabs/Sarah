import test from "node:test";
import assert from "node:assert/strict";
import { toggleSubjectiveEpisode, totalEpisodeSeconds, subjectiveProximity, summarizeSubjectiveEpisode } from "./subjectiveNearClimax.js";
const rows = Array.from({ length: 200 }, (_, t) => ({ time_offset_s: t, hr: 80 + t / 10, baseline_hr: 80, hrv_rmssd_ms: 20, hrv_quality: "high" }));
const source = { key: "lower_body", localPath: "E:/feet.mkv", timelineOffsetSeconds: 3 };
test("N start/end preserves one episode, exact timestamps, source and thumbnail across reload", () => {
  const start = toggleSubjectiveEpisode([], 20.125, source, "data:image/jpeg;base64,test", rows, {}, "n1");
  const restored = JSON.parse(JSON.stringify(start));
  const closed = toggleSubjectiveEpisode(restored, 35.625, {}, "", rows, {}, "unused");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].id, "n1");
  assert.equal(closed[0].duration_s, 15.5);
  assert.deepEqual(closed[0].source, source);
  assert.equal(closed[0].thumbnail_url, start[0].thumbnail_url);
  assert.equal(closed[0].evidence_status, "user_reported");
  assert.ok(closed[0].telemetry.hr_sample_count > 0);
});
test("N and C have independent start/stop state and do not overwrite each other", () => {
  let list = toggleSubjectiveEpisode([], 20, source, "near", rows, {}, "n", "near_climax");
  list = toggleSubjectiveEpisode(list, 30, source, "climax", rows, {}, "c", "climax");
  list = toggleSubjectiveEpisode(list, 40, source, "", rows, {}, "unused", "climax");
  assert.equal(list.find((e) => e.kind === "near_climax").end_s, null);
  assert.equal(list.find((e) => e.kind === "climax").duration_s, 10);
  list = toggleSubjectiveEpisode(list, 45, source, "", rows, {}, "unused", "near_climax");
  assert.equal(list.length, 2);
  assert.equal(totalEpisodeSeconds(list, "near_climax"), 25);
  assert.equal(totalEpisodeSeconds(list, "climax"), 10);
});
test("backward/equal-time stops are rejected without mutating the open marker", () => {
  const list = toggleSubjectiveEpisode([], 20, source, "image", rows, {}, "n");
  for (const end of [10, 20]) assert.throws(() => toggleSubjectiveEpisode(list, end, source, "", rows, {}, "n"), /end must be after/);
  assert.equal(list[0].end_s, null);
});
test("totals union overlapping intervals and exclude incomplete intervals", () => {
  assert.equal(totalEpisodeSeconds([{ start_s: 1, end_s: 10 }, { start_s: 5, end_s: 12 }, { start_s: 20, end_s: null }], "near_climax"), 11);
});
test("missing telemetry stays missing and user-marked climax takes precedence over estimates", () => {
  const result = summarizeSubjectiveEpisode(10, 20, [], { climax_offset_s: null });
  assert.equal(result.telemetry.hr_mean, null);
  assert.equal(result.proximity, null);
  assert.deepEqual(subjectiveProximity({ start_s: 10, end_s: 20 }, [{ kind: "climax", start_s: 25 }], null),
    { kind: "User-marked climax", time_s: 25, relative_to_episode_s: 5 });
});
