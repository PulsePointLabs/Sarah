import test from "node:test";
import assert from "node:assert/strict";
import { episodeReviewContext, slimSeriesPath, episodeDuration, episodeClock } from "./episodeReviewContext.js";

test("context includes full episode plus 30 seconds on each side, with distinct summary windows", () => {
  const rows = [{ time_offset_s: 69, hr: 500 }, { time_offset_s: 70, hr: 80 }, { time_offset_s: 100, hr: 100 },
    { time_offset_s: 120, hr: 110 }, { time_offset_s: 130, hr: 90 }, { time_offset_s: 150, hr: 80 }, { time_offset_s: 151, hr: 500 }];
  const context = episodeReviewContext({ start_s: 100, end_s: 120 }, rows, [{ t: 100, recovery: 40 }]);
  assert.deepEqual(context.domain, [70, 150]);
  assert.equal(context.samples.length, 5);
  assert.equal(context.before.hr, 80);
  assert.equal(context.during.count, 2);
  assert.equal(context.after.count, 2);
  assert.equal(context.phases[0].recovery, 40);
});
test("missing channels stay blank and telemetry gaps break the plotted line", () => {
  const context = episodeReviewContext({ start_s: 2, end_s: 4 }, [{ time_offset_s: 2, hr: 80 }], []);
  assert.equal(context.before.rmssd, null);
  assert.equal(context.domain[0], 0);
  const path = slimSeriesPath([{ t: 0, hr: 80 }, { t: 1, hr: 82 }, { t: 10, hr: 90 }, { t: 11, hr: null }, { t: 12, hr: 91 }], "hr", (t) => t, (n) => n);
  assert.equal((path.match(/M/g) || []).length, 3);
});
test("durations use minutes and seconds with correct rounding across minute boundaries", () => {
  assert.equal(episodeDuration(2985.7), "49m 45.7s");
  assert.equal(episodeDuration(272), "4m 32s");
  assert.equal(episodeDuration(59.99), "1m 0s");
  assert.equal(episodeClock(59.99), "1:00.0");
});
