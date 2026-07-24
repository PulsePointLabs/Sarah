import test from "node:test";
import assert from "node:assert/strict";
import {
  H10_ACCELEROMETER_START_COMMAND,
  appendBoundedSamples,
  createH10PmdParserState,
  describeH10PmdStatus,
  deriveH10MultimodalSnapshot,
  detectH10TapGesture,
  fuseRespiration,
  isH10PmdStreamActiveResponse,
  parseH10PmdFrame,
} from "./h10Multimodal.js";

test("uses only H10-supported accelerometer settings", () => {
  assert.deepEqual([...H10_ACCELEROMETER_START_COMMAND], [
    0x02, 0x02,
    0x00, 0x01, 0x19, 0x00,
    0x01, 0x01, 0x10, 0x00,
    0x02, 0x01, 0x02, 0x00,
  ]);
  assert.equal(describeH10PmdStatus(5), "invalid parameter");
});

function writeSigned24(target, offset, value) {
  const normalized = value < 0 ? value + 0x1000000 : value;
  target[offset] = normalized & 0xff;
  target[offset + 1] = (normalized >> 8) & 0xff;
  target[offset + 2] = (normalized >> 16) & 0xff;
}

test("parses uncompressed H10 ECG PMD samples", () => {
  const bytes = new Uint8Array(16);
  bytes[0] = 0;
  bytes[1] = 0x00;
  bytes[2] = 0xca;
  bytes[3] = 0x9a;
  bytes[4] = 0x3b;
  bytes[9] = 0;
  writeSigned24(bytes, 10, 250);
  writeSigned24(bytes, 13, -125);
  const states = {
    ecg: createH10PmdParserState(130),
    accelerometer: createH10PmdParserState(25),
  };
  const parsed = parseH10PmdFrame(new DataView(bytes.buffer), states, 10_000);
  assert.equal(parsed.type, "ecg");
  assert.deepEqual(parsed.samples.map((sample) => sample.microvolts), [250, -125]);
  assert.ok(parsed.samples[1].timestampMs >= parsed.samples[0].timestampMs);
});

test("bounded sensor buffers discard stale samples", () => {
  const result = appendBoundedSamples(
    [{ timestampMs: 1000 }, { timestampMs: 5000 }],
    [{ timestampMs: 9000 }],
    { maxAgeMs: 5000, maxSamples: 10, nowMs: 10_000 },
  );
  assert.deepEqual(result.map((sample) => sample.timestampMs), [5000, 9000]);
});

test("treats PMD already-in-state as an idempotent active stream", () => {
  assert.equal(isH10PmdStreamActiveResponse({ success: false, status: 6 }), true);
  assert.equal(isH10PmdStreamActiveResponse({ success: false, status: 5 }), false);
});

test("triple H10 impulses create one debounced marker gesture", () => {
  const samples = [
    { timestampMs: 1000, xMilliG: 0, yMilliG: 0, zMilliG: 1000 },
    { timestampMs: 1200, xMilliG: 1500, yMilliG: 0, zMilliG: 1000 },
    { timestampMs: 1500, xMilliG: 0, yMilliG: 0, zMilliG: 1000 },
    { timestampMs: 1750, xMilliG: 1500, yMilliG: 0, zMilliG: 1000 },
    { timestampMs: 2050, xMilliG: 0, yMilliG: 0, zMilliG: 1000 },
    { timestampMs: 2300, xMilliG: 1500, yMilliG: 0, zMilliG: 1000 },
  ];
  const result = detectH10TapGesture(samples, {}, 2400);
  assert.equal(result.gesture?.type, "triple_tap");
});

test("respiration stays unavailable during high motion", () => {
  const nowMs = 70_000;
  const accelerometerSamples = Array.from({ length: 1500 }, (_unused, index) => ({
    timestampMs: 10_000 + index * 40,
    xMilliG: index % 2 ? 1500 : -1500,
    yMilliG: 0,
    zMilliG: 1000,
  }));
  const result = deriveH10MultimodalSnapshot({ accelerometerSamples, nowMs });
  assert.equal(result.motion.class, "high_motion");
  assert.equal(result.respiration.available, false);
  assert.equal(result.respiration.reason, "motion_limited");
});

test("ECG-derived respiration remains available when ambulatory motion blocks accelerometer breathing", () => {
  const result = fuseRespiration(
    { accepted: false, reason: "motion_limited" },
    { accepted: true, bpm: 17, confidence: "high", source: "ecg_derived" },
  );
  assert.equal(result.available, true);
  assert.equal(result.bpm, 17);
  assert.equal(result.source, "ecg_derived");
  assert.equal(result.confidence, "moderate");
});

test("RR modulation provides an explicitly indirect fallback when PMD streams are unavailable", () => {
  const rrIntervalsMs = Array.from({ length: 120 }, (_unused, index) => (
    800 + (45 * Math.sin(2 * Math.PI * index / 5))
  ));
  const result = deriveH10MultimodalSnapshot({
    rrIntervalsMs,
    rrQuality: "high",
    nowMs: 70_000,
  });
  assert.equal(result.respiration.available, true);
  assert.equal(result.respiration.source, "rr_interval_modulation");
  assert.ok(["limited", "moderate"].includes(result.respiration.confidence));
  assert.equal(result.respiration.possibleBreathHold, false);
});

test("respiration exposes the RR fallback failure when raw PMD streams are unavailable", () => {
  const result = fuseRespiration(
    { accepted: false, reason: "insufficient_window" },
    { accepted: false, reason: "insufficient_window" },
    { accepted: false, reason: "low_rr_periodicity" },
  );
  assert.equal(result.available, false);
  assert.equal(result.reason, "low_rr_periodicity");
});

test("stable periodic chest acceleration can produce a conservative rate", () => {
  const nowMs = 70_000;
  const accelerometerSamples = Array.from({ length: 1500 }, (_unused, index) => {
    const timestampMs = 10_000 + index * 40;
    const seconds = timestampMs / 1000;
    return {
      timestampMs,
      xMilliG: Math.round(28 * Math.sin(2 * Math.PI * 0.25 * seconds)),
      yMilliG: 0,
      zMilliG: 1000,
    };
  });
  const result = deriveH10MultimodalSnapshot({ accelerometerSamples, nowMs });
  assert.equal(result.respiration.available, true);
  assert.ok(result.respiration.bpm >= 13 && result.respiration.bpm <= 17);
});
