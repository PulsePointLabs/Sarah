import assert from "node:assert/strict";
import test from "node:test";
import { buildRecentSessionActivityContext } from "./recentSessionActivity.js";

test("includes recent body exploration catheter facts ahead of older sessions", () => {
  const context = buildRecentSessionActivityContext(
    [{ date: "2026-07-22", start_time: "01:33", methods: ["Manual"], notes: "Prior masturbation session." }],
    [{
      date: "2026-07-23",
      start_time: "17:29",
      title: "24 French Foley insertion",
      methods: ["Live Capture", "Foley Catheter"],
      foley_size: 24,
      foley_type: "Dover",
      notes: "Smooth catheter insertion.",
      event_timeline: [{ source: "manual", note: "Catheter tip enters the meatus and advancement begins." }],
    }],
  );

  assert.match(context, /24 French Foley insertion/);
  assert.match(context, /Recorded catheter: 24 French Dover Foley catheter/);
  assert.match(context, /Catheter tip enters the meatus/);
  assert.ok(context.indexOf("2026-07-23") < context.indexOf("2026-07-22"));
});

test("tells Sarah not to assume a prior device remains active", () => {
  const context = buildRecentSessionActivityContext([], [{
    date: "2026-07-23",
    title: "Foley insertion",
    foley_size: 24,
  }]);

  assert.match(context, /not as proof of the user's current physical state/i);
});
