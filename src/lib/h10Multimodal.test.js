import test from "node:test";
import assert from "node:assert/strict";
import {
  appendBoundedSamples,
  createH10PmdParserState,
  deriveH10MultimodalSnapshot,
  detectH10TapGesture,
  parseH10PmdFrame,
} from "./h10Multimodal.js";

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
