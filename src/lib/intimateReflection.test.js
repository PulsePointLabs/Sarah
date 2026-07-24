import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIntimateReflectionEvidence,
  intimateReflectionEvidenceFingerprint,
  intimateReflectionFingerprint,
  intimateReflectionNeedsRefresh,
  intimateReflectionReaderData,
  normalizeIntimateReflectionResult,
  normalizeIntimateReflectionSettings,
} from "./intimateReflection.js";

test("normalizes reflection settings and fingerprints custom instructions", () => {
  assert.deepEqual(normalizeIntimateReflectionSettings({ level: "erotic", customInstructions: "  steady   and warm " }), {
    level: "erotic",
    customInstructions: "steady and warm",
  });
  assert.notEqual(
    intimateReflectionFingerprint({ level: "warm" }),
    intimateReflectionFingerprint({ level: "intimate" }),
  );
});

test("builds compact evidence from session events and telemetry", () => {
  const evidence = buildIntimateReflectionEvidence({
    date: "2026-07-24",
    methods: ["Manual"],
    event_timeline: [{ time_s: 45, category: "Build", note: "Pace increased", hr: 105 }],
    ai_analysis: { summary: "A steady build.", arousal_arc: ["Load increased."] },
  }, [
    { time_offset_s: 0, hr: 80 },
    { time_offset_s: 45, hr_smoothed: 105 },
  ]);
  assert.equal(evidence.confirmed_timeline_events[0].time_seconds, 45);
  assert.equal(evidence.telemetry.maximum_heart_rate, 105);
  assert.equal(evidence.saved_analysis.summary, "A steady build.");
});

test("normalizes a structured result and builds readable paragraphs", () => {
  const result = normalizeIntimateReflectionResult({
    summary: "A warm opening.",
    reflection: ["A grounded reflection."],
    moments: [{ time_seconds: 65, label: "Build", reflection: "The pace became steadier.", evidence: "Saved event." }],
    closing: "A complete closing.",
  });
  const reader = intimateReflectionReaderData(result);
  assert.equal(reader.paragraphs.length, 4);
  assert.match(reader.paragraphs[2], /^1:05 Build\./);
});

test("detects settings or evidence changes without marking a matching result stale", () => {
  const settings = { level: "intimate", customInstructions: "" };
  const evidence = buildIntimateReflectionEvidence({ ai_analysis: { summary: "Saved." } }, []);
  const matching = {
    _meta: {
      settings_fingerprint: intimateReflectionFingerprint(settings),
      evidence_fingerprint: intimateReflectionEvidenceFingerprint(evidence),
    },
  };
  assert.equal(intimateReflectionNeedsRefresh(matching, settings, evidence), false);
  assert.equal(intimateReflectionNeedsRefresh(matching, { level: "warm" }, evidence), true);
});
