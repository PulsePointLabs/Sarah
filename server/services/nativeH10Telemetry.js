import { computeHrvFromRr } from './hrSources.js';
import { appendBoundedSamples, createH10PmdParserState, deriveH10MultimodalSnapshot, detectH10TapGesture, parseH10PmdFrame } from '../../src/lib/h10Multimodal.js';

export function decodeNativeHeartRate(hex) {
  if (typeof hex !== 'string' || !/^(?:[\da-f]{2})+$/i.test(hex)) throw new Error('Invalid native HR packet');
  const bytes = Buffer.from(hex, 'hex');
  const flags = bytes[0];
  let offset = flags & 1 ? 3 : 2;
  if (bytes.length < offset) throw new Error('Truncated native HR packet');
  const heartRate = flags & 1 ? bytes.readUInt16LE(1) : bytes[1];
  if (flags & 8) offset += 2;
  if (offset > bytes.length || ((flags & 16) && (bytes.length - offset) % 2)) throw new Error('Truncated native RR packet');
  const rrIntervalsMs = [];
  if (flags & 16) for (; offset + 1 < bytes.length; offset += 2) rrIntervalsMs.push(bytes.readUInt16LE(offset) * 1000 / 1024);
  return { heartRate, rrIntervalsMs };
}

// This is the same PMD parser and derived physiology used by the visible Live Capture page.
// Native receipt times anchor it, not the time a suspended WebView happens to wake up.
export function createNativeH10Decoder() {
  const collectors = new Map();
  return (packet, context = {}) => {
    const at = Number(packet.measuredAt);
    if (!Number.isFinite(at) || at <= 0 || at > Date.now() + 60_000) throw new Error('Invalid native receipt timestamp');
    const hr = decodeNativeHeartRate(packet.heartRatePacket);
    let store = collectors.get(packet.collectorId);
    if (!store || store.connectionId !== packet.connectionId) {
      store = { connectionId: packet.connectionId, rr: [], ecg: [], accelerometer: [], history: [], parsers: {
        ecg: createH10PmdParserState(130), accelerometer: createH10PmdParserState(25),
      } };
      collectors.set(packet.collectorId, store);
      if (collectors.size > 8) collectors.delete(collectors.keys().next().value);
    }
    if (store.packetId === packet.packetId) return store.result;
    if (at - (store.lastAt || at) > 5000) store.rr = [];
    store.rr = [...store.rr, ...hr.rrIntervalsMs].filter((v) => v >= 300 && v <= 2000).slice(-180);
    const hrv = computeHrvFromRr(store.rr);
    const sensorBatch = { ecg: [], accelerometer: [] };
    const gestures = [];
    const frameErrors = [];
    for (const frame of (packet.pmdFrames || []).slice(0, 300)) {
      try {
        const parsed = parseH10PmdFrame(Buffer.from(frame.value, 'hex'), store.parsers, Number(frame.receivedAt));
        sensorBatch[parsed.type].push(...parsed.samples);
        if (parsed.type === 'accelerometer') {
          const tap = detectH10TapGesture(parsed.samples, store.tapState, Number(frame.receivedAt));
          store.tapState = tap.state;
          if (tap.gesture) gestures.push(tap.gesture);
        }
      } catch (error) { frameErrors.push(error.message); }
    }
    for (const key of ['ecg', 'accelerometer']) store[key] = appendBoundedSamples(store[key], sensorBatch[key], {
      maxAgeMs: 70_000, maxSamples: key === 'ecg' ? 9500 : 1900, nowMs: at,
    });
    store.history = [...store.history, { ts: at, heartRate: hr.heartRate, hr: hr.heartRate }].filter((v) => v.ts >= at - 180_000);
    const multimodal = deriveH10MultimodalSnapshot({
      ecgSamples: store.ecg, accelerometerSamples: store.accelerometer,
      rrIntervalsMs: store.rr, rrQuality: hrv.quality, currentHr: hr.heartRate,
      hrHistory: store.history, baselineOrientation: store.baselineOrientation, nowMs: at,
      baselineHr: context.baselineHr, eventHistory: context.eventHistory || [],
    });
    if (!store.baselineOrientation && multimodal.motion?.class === 'low_motion') store.baselineOrientation = multimodal.position?.currentOrientation;
    store.packetId = packet.packetId;
    store.lastAt = at;
    store.result = {
      ...hr, collectorId: packet.collectorId, collectorKind: packet.collectorKind, deviceName: packet.deviceName,
      measuredAt: at, receivedAt: at, hrv, multimodal, sensorBatch, gestures,
      quality: { nativeBackgroundCapture: true, deliveryDelayMs: Math.max(0, Date.now() - at), frameErrors },
    };
    return store.result;
  };
}
