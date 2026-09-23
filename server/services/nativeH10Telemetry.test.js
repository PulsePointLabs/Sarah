import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createNativeH10Decoder, decodeNativeHeartRate } from './nativeH10Telemetry.js';
import { normalizeDirectH10Telemetry } from './hrSources.js';

function packet(overrides = {}) {
  return { nativeH10: true, packetId: randomUUID(), collectorId: 'phone', connectionId: 'connection-1',
    measuredAt: Date.now() - 120_000, heartRatePacket: '105a00040003', pmdFrames: [], ...overrides };
}

test('native HR packets decode both RR values with Bluetooth 1/1024-second units', () => {
  assert.deepEqual(decodeNativeHeartRate('105a00040003'), { heartRate: 90, rrIntervalsMs: [1000, 750] });
  assert.deepEqual(decodeNativeHeartRate('19400102000004'), { heartRate: 320, rrIntervalsMs: [1000] });
  assert.deepEqual(decodeNativeHeartRate('005a'), { heartRate: 90, rrIntervalsMs: [] });
});

test('bad or truncated native packets fail visibly rather than inventing telemetry', () => {
  for (const value of ['', 'zz', '105', '105a00', '01', '085a00']) assert.throws(() => decodeNativeHeartRate(value));
});

test('delayed delivery preserves native receipt time and measures delivery delay separately', () => {
  const original = packet();
  const result = createNativeH10Decoder()(original);
  const normalized = normalizeDirectH10Telemetry(result, result.measuredAt);
  assert.equal(normalized.receivedAt, original.measuredAt);
  assert.equal(normalized.measuredAt, original.measuredAt);
  assert.ok(result.quality.deliveryDelayMs >= 120000);
});

test('RR window continues independently of UI, retries do not count RR twice, reconnect resets it', () => {
  const decode = createNativeH10Decoder();
  const first = packet();
  const result = decode(first);
  assert.equal(decode(first), result);
  let next;
  for (let i = 1; i < 40; i++) next = decode(packet({ measuredAt: first.measuredAt + i * 1000 }));
  assert.ok(next.hrv.rmssdMs > 0);
  assert.ok(next.hrv.sampleCount > result.hrv.sampleCount);
  const restarted = decode(packet({ connectionId: 'connection-2', measuredAt: first.measuredAt + 40000 }));
  assert.equal(restarted.hrv.sampleCount, result.hrv.sampleCount);
});

test('native PMD ECG and accelerometer data keep original timestamps and share normal decoder', () => {
  const original = packet();
  const ecg = Buffer.alloc(13); ecg[0] = 0; ecg.writeBigUInt64LE(1_000_000_000n, 1); ecg[10] = 23;
  const accel = Buffer.alloc(16); accel[0] = 2; accel.writeBigUInt64LE(1_000_000_000n, 1); accel[9] = 1; accel.writeInt16LE(1000, 14);
  original.pmdFrames = [ecg, accel].map((frame) => ({ value: frame.toString('hex'), receivedAt: original.measuredAt - 100 }));
  const result = createNativeH10Decoder()(original);
  assert.equal(result.sensorBatch.ecg[0].microvolts, 23);
  assert.equal(result.sensorBatch.ecg[0].timestampMs, original.measuredAt - 100);
  assert.equal(result.sensorBatch.accelerometer[0].zMilliG, 1000);
  assert.equal(result.multimodal.streams.ecg.sampleCount, 1);
  assert.equal(result.multimodal.streams.accelerometer.sampleCount, 1);
});

test('malformed PMD cannot stop HR/RR and remains reported as an error', () => {
  const result = createNativeH10Decoder()(packet({ pmdFrames: [{ value: '00', receivedAt: Date.now() }] }));
  assert.equal(result.heartRate, 90);
  assert.equal(result.quality.frameErrors.length, 1);
});

test('a real interruption clears the rolling RR window instead of implying continuous coverage', () => {
  const decode = createNativeH10Decoder();
  const at = Date.now() - 30000;
  const first = decode(packet({ measuredAt: at }));
  decode(packet({ measuredAt: at + 1000 }));
  assert.equal(decode(packet({ measuredAt: at + 20000 })).hrv.sampleCount, first.hrv.sampleCount);
});
