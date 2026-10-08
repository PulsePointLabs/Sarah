import test from 'node:test';
import assert from 'node:assert/strict';
import { packCivetTimeline, unpackCivetTimeline } from '../../src/lib/civetTimelineTransport.js';

test('timeline transport preserves every mode, missing values, calibration, gaps, events and timestamps', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    t: i / 10, pressure_kpa: i / 5, usable: i > 20, calibration: { baseline: 2, reference: 5, valid: true },
    evidence: 'Recorded pressure with calibration and original timing',
    gap: i === 100, raw_packet_hex: 'abcdef0123', events: i === 150 ? [{ peak: 15, confidence: .7 }] : [],
    ...(i % 2 ? { optional: null } : {}),
  }));
  const data = { samples: rows, analysis: { live: { events: [] }, review: { rows, events: [{ peak: 15 }] }, reprocessed: { rows } } };
  const packed = packCivetTimeline(data);
  const { encoding, ...restored } = unpackCivetTimeline(JSON.parse(JSON.stringify(packed)));
  assert.equal(encoding, 'civet-columns-v1');
  assert.deepEqual(restored, data);
  assert.ok(JSON.stringify(packed).length < JSON.stringify(data).length / 2);
  assert.equal(unpackCivetTimeline(data), data);
});

test('empty and active recordings retain their original meaning', () => {
  const data = { samples: [], analysis: { active: true, review: null, reprocessed: null } };
  assert.deepEqual(unpackCivetTimeline(packCivetTimeline(data)).samples, []);
  assert.equal(unpackCivetTimeline(packCivetTimeline(data)).analysis.active, true);
});
