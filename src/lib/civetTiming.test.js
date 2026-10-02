import test from 'node:test';
import assert from 'node:assert/strict';
import { civetTimingGap, civetTraceBreak } from './civetTiming.js';
import { createCivetProcessor, civetAt } from './civet.js';
import { analyzeCivetReview } from './civetAnalysis.js';
import { reprocessCivetRecording } from './civetReprocess.js';

const calibration = { id: 'verified', baseline: 20, reference: 4, noise: .02 };
function jittered() {
  const p = createCivetProcessor({ verifiedCalibration: calibration });
  // Alternate delayed notifications and a closely following notification. Keep
  // sample order and receipt time; no assumption about undocumented packet bytes.
  return Array.from({ length: 300 }, (_, i) => {
    const t = i / 10 + (i % 2 ? .095 : 0);
    return { ...p.ingest(21 + Math.cos(i / 10 * Math.PI), t), timestamp_ms: 100000 + t * 1000,
      raw_packet_hex: `original-${i}`, connection_id: 1, capture_id: 'test', sequence: i };
  });
}
test('batched receipt timing stays continuous in capture, plot, lookup and review', () => {
  const rows = jittered(), copy = JSON.stringify(rows), review = analyzeCivetReview(rows);
  assert.ok(rows.every(r => r.usable && !r.gap));
  assert.equal(rows.slice(1).filter((r, i) => civetTraceBreak(rows[i], r)).length, 0);
  assert.equal(civetAt(rows, .19), rows[0]);
  assert.ok(review.events.filter(e => e.quality === 'usable').length >= 10);
  assert.equal(review.rows.filter(r => r.quality_flags.includes('filter_edge')).length, 2);
  assert.equal(JSON.stringify(rows), copy);
  assert.deepEqual(review.rows.map(r => [r.t, r.timestamp_ms, r.pressure_kpa, r.raw_packet_hex]), rows.map(r => [r.t, r.timestamp_ms, r.pressure_kpa, r.raw_packet_hex]));
});
test('real outage, reconnect, clock reversal and explicit gaps still split the plot and review', () => {
  const original = jittered();
  const rows = original.filter(r => r.t < 10 || r.t >= 11);
  const resumed = rows.findIndex(r => r.t >= 11);
  assert.equal(civetTimingGap(rows[resumed - 1], rows[resumed]), true);
  assert.equal(civetAt(rows, 10.8), null);
  const review = analyzeCivetReview(rows);
  assert.equal(review.rows[resumed].gap, true);
  assert.ok(!review.events.some(e => e.onset < 10 && e.end > 11));
  for (const next of [{t:.1,connection_id:2}, {t:.1,capture_id:'new'}, {t:-.1}, {t:.1,gap:true}]) {
    assert.equal(civetTraceBreak({t:0,connection_id:1,capture_id:'old'}, next), true);
  }
  assert.equal(civetTimingGap({t:100}, {t:100.35}), false);
  assert.equal(civetTimingGap({t:100}, {t:100.351}), true);
});
test('replay preserves evidence and references, is reproducible and exposes real percentages', () => {
  const rows = jittered(), before = JSON.stringify(rows);
  const a = reprocessCivetRecording(rows), b = reprocessCivetRecording(rows);
  assert.deepEqual(a,b);
  assert.equal(JSON.stringify(rows), before);
  for (let i = 0; i < rows.length; i++) {
    for (const key of ['t','timestamp_ms','pressure_kpa','raw_packet_hex','connection_id','capture_id','sequence','calibration']) assert.deepEqual(a.rows[i][key],rows[i][key]);
  }
  const p = createCivetProcessor({verifiedCalibration:calibration});
  assert.equal(p.ingest(28,0).level_pct,200);
  assert.equal(p.ingest(24,.1).level_pct,100);
  assert.equal(p.ingest(20,.2).level_pct,0);
});
