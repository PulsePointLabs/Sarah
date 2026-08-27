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

test("timestamp-aligned active stimulation plus a direct threshold cue confirms a near-climax candidate", () => {
  const assessment = assessNearClimaxEventContext(
    { start_offset_s: 1380, peak_offset_s: 1450, end_offset_s: 1520 },
    [{ start_s: 1400, end_s: 1470, note: "Active stroking accelerates at the near-climax threshold", category: ["visual"], evidence_source: "video_pass" }],
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
      { time_s: 2180, note: "Active stroking accelerates at the near-climax threshold", category: ["physical"] },
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

test("August 23 phase markers reject setup and early build while retaining the true threshold window", () => {
  const session = {
    pre_climax_offset_s: 305,
    climax_offset_s: 452,
    recovery_offset_s: 480,
    event_timeline: [
      { time_s: 61, note: "Mounting table", category: ["setup"] },
      { time_s: 73, note: "Adjusting monitors", category: ["technical"] },
      { time_s: 77, note: "Remounting exam tables", category: ["setup"] },
      { time_s: 90, note: "Initial contact with flaccid penis", category: ["physical"] },
      { time_s: 209, note: "Stimulation resumed", category: ["physical"] },
      { time_s: 211, note: "Rapid light strokes", category: ["physical"] },
      { time_s: 236, note: "Paused to adjust camera", category: ["technical"] },
      { time_s: 240, note: "Stimulation resumes", category: ["physical"] },
      { time_s: 364, note: "Active stroking continues through the saved pre-climax phase", category: ["physical"] },
    ],
    ai_near_climax_events: [
      { start_offset_s: 46, peak_offset_s: 79, end_offset_s: 121, context_confirmed: true, evidence_status: "context_confirmed" },
      { start_offset_s: 196, peak_offset_s: 226, end_offset_s: 287, context_confirmed: true, evidence_status: "context_confirmed" },
      { start_offset_s: 311, peak_offset_s: 364, end_offset_s: 394, context_confirmed: true, evidence_status: "context_confirmed" },
    ],
  };

  const confirmed = confirmedNearClimaxEventsForSession(session);
  assert.deepEqual(confirmed.map((event) => event.peak_offset_s), [364]);
  assert.equal(confirmed[0].context_evidence.manualThresholdCue, true);
  assert.equal(confirmed[0].context_evidence.activeMasturbation, true);
});

test("generic erection and genital changes do not prove near climax without active masturbation", () => {
  const evidence = buildNearClimaxContextEvidence({
    pre_climax_offset_s: 300,
    event_timeline: [{ time_s: 320, note: "Erection becomes fuller; glans engorgement and scrotal lift are visible", category: ["physical"] }],
  });
  const assessment = assessNearClimaxEventContext({ start_offset_s: 305, peak_offset_s: 320, end_offset_s: 350 }, evidence);

  assert.equal(assessment.activeMasturbation, false);
  assert.equal(assessment.confirmed, false);
});

test("active stroking before the manually saved pre-climax phase is build, not near climax", () => {
  const evidence = buildNearClimaxContextEvidence({
    pre_climax_offset_s: 305,
    event_timeline: [{ time_s: 226, note: "Rapid active stroking continues", category: ["physical"] }],
  });
  const assessment = assessNearClimaxEventContext({ start_offset_s: 196, peak_offset_s: 226, end_offset_s: 287 }, evidence);

  assert.equal(assessment.confirmed, false);
  assert.equal(assessment.contradicted, true);
  assert.equal(assessment.status, "before_pre_climax");
});

test("stale saved confirmation flags cannot bypass current evidence assessment", () => {
  const confirmed = confirmedNearClimaxEventsForSession({
    event_timeline: [{ time_s: 80, note: "Mounting table and adjusting monitors", category: ["setup"] }],
    ai_near_climax_events: [{
      start_offset_s: 46,
      peak_offset_s: 79,
      end_offset_s: 121,
      context_confirmed: true,
      evidence_status: "context_confirmed",
    }],
  });

  assert.equal(confirmed.length, 0);
});

test("active stimulation outside the peak-centered evidence window does not confirm the candidate", () => {
  const assessment = assessNearClimaxEventContext(
    { start_offset_s: 100, peak_offset_s: 130, end_offset_s: 180 },
    [{ time_s: 165, note: "Active stroking at the near-climax threshold", category: ["physical"] }],
  );

  assert.equal(assessment.confirmed, false);
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
