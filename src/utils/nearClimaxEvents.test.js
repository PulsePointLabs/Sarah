import test from "node:test";
import assert from "node:assert/strict";
import {
  assessNearClimaxEventContext,
  buildNearClimaxContextEvidence,
  confirmedNearClimaxEventsForSession,
  detectNearClimaxEvents,
} from "./nearClimaxEvents.js";

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

test("walking and technical frustration contradict a physiology-only near-climax candidate", () => {
  const assessment = assessNearClimaxEventContext(
    { start_offset_s: 1380, end_offset_s: 1520 },
    [{ time_s: 1450, note: "Got off the exam table and walked over to fight the computer again", category: ["physical", "technical"] }],
  );

  assert.equal(assessment.contradicted, true);
  assert.equal(assessment.confirmed, false);
  assert.equal(assessment.status, "contradicted");
});

test("timestamp-aligned visual arousal change confirms a near-climax candidate", () => {
  const assessment = assessNearClimaxEventContext(
    { start_offset_s: 1380, end_offset_s: 1520 },
    [{ start_s: 1400, end_s: 1470, note: "Active stroking accelerates while the toes curl and the legs brace", category: ["visual"], evidence_source: "video_pass" }],
  );

  assert.equal(assessment.confirmed, true);
  assert.equal(assessment.contradicted, false);
  assert.equal(assessment.status, "context_confirmed");
  assert.deepEqual(assessment.positiveSources, ["video_pass"]);
});

test("live physiology detector notes cannot circularly confirm themselves", () => {
  const session = {
    event_timeline: [{
      time_s: 1450,
      note: "Sustained near-climax watch reached 82% with 3 confirming signal families.",
      category: ["physiology", "phase_detection"],
      source: "live_climax_prediction",
    }],
  };
  const evidence = buildNearClimaxContextEvidence(session);
  const assessment = assessNearClimaxEventContext({ start_offset_s: 1380, end_offset_s: 1520 }, evidence);

  assert.equal(assessment.confirmed, false);
  assert.equal(assessment.status, "context_unconfirmed");
});

test("detector rejects a strong HR and HRV surge when nearby evidence says Ben was walking", () => {
  const rows = buildFixtureRows();
  const events = detectNearClimaxEvents(rows, 2660, 2580, [
    { time_s: 1450, note: "Standing up, walking away from the table, and troubleshooting the app", category: ["technical"] },
    { time_s: 2180, note: "strong tremble and surge with breath hold", category: ["physical"] },
  ]);

  assert.equal(events.some((event) => event.start_offset_s >= 1360 && event.start_offset_s <= 1420), false);
  assert.equal(events.some((event) => event.start_offset_s >= 2080 && event.start_offset_s <= 2140), true);
});

test("only context-confirmed saved events reach confirmed timeline overlays", () => {
  const session = {
    event_timeline: [
      { time_s: 1450, note: "Got off the table and walked to the computer", category: ["technical"] },
      { time_s: 2180, note: "Active stroking accelerates with toe curl and breath hold", category: ["physical"] },
    ],
    ai_near_climax_events: [
      { start_offset_s: 1380, end_offset_s: 1520, peak_offset_s: 1450 },
      { start_offset_s: 2100, end_offset_s: 2240, peak_offset_s: 2180 },
      { start_offset_s: 500, end_offset_s: 560, peak_offset_s: 530 },
    ],
  };

  const confirmed = confirmedNearClimaxEventsForSession(session);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].peak_offset_s, 2180);
});

test("saved video-pass windows become timestamp-aligned near-climax evidence", () => {
  const evidence = buildNearClimaxContextEvidence({
    ai_analysis: {
      _video_pass_findings: [{
        clip: { start_s: 600, end_s: 624 },
        summary: "Stroke speed increases and both feet brace against the table.",
        findings: ["Glans appears more engorged across the window."],
      }],
    },
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].start_s, 600);
  assert.equal(evidence[0].end_s, 624);
  assert.match(evidence[0].note, /Stroke speed increases/);
});
