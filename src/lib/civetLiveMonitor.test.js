import test from 'node:test';
import assert from 'node:assert/strict';
import { createCivetMonitorSummary, civetLiveSnapshot, updateCivetMonitorZoom } from './civetLiveMonitor.js';
const row = (t, delta = .2, patch = {}) => ({ t, delta_kpa: delta, usable: true, calibration_valid: true, calibration: { id: 'ref', reference: 2 }, capture_id: 'capture', duration_s: 0, events: [], ...patch });
test('summary excludes invalid and gap samples and resets at calibration changes', () => {
  const summarize = createCivetMonitorSummary();
  summarize(row(0, 1, { duration_s: 4 }));
  summarize(row(1, 100, { usable: false }));
  summarize(row(2, 100, { gap: true }));
  assert.deepEqual(summarize(row(3, 3)), { average: 2, max: 3, longest: 4, count: 2, calibrationId: 'ref' });
  assert.equal(summarize(row(4, .5, { calibration: { id: 'new' } })).average, .5);
});
test('current hold and resolved pulse remain distinct; missing signal keeps historical trace', () => {
  const event = { id: 'pulse', quality: 'usable', onset: 8, end: 9, peak: 8.5, confirmed_at: 9, duration_s: 1, calibration: { id: 'ref' } };
  const history = [row(9, .2, { events: [event] }), row(10)];
  const live = { latest: history.at(-1), history };
  assert.equal(civetLiveSnapshot(live).duration, 1);
  assert.equal(civetLiveSnapshot(live).held, false);
  assert.equal(civetLiveSnapshot({ ...live, latest: row(11, 1, { duration_s: 2 }) }).duration, 2);
  const missing = civetLiveSnapshot({ ...live, latest: null, age_ms: 2000 });
  assert.equal(missing.current, null); assert.equal(missing.duration, null);
  assert.equal(missing.history.length, 2); assert.equal(missing.end, 12);
});
test('auto zoom latches, releases, honors override and does not change vertical scale on zoom', () => {
  const strong = row(10, 1.5, { duration_s: 1 });
  let snapshot = civetLiveSnapshot({ latest: strong, history: [strong] });
  let zoom = updateCivetMonitorZoom({}, snapshot);
  assert.equal(zoom.seconds, 8);
  snapshot = civetLiveSnapshot({ latest: row(17), history: [strong, row(17)] });
  zoom = updateCivetMonitorZoom(zoom, snapshot);
  assert.equal(zoom.seconds, 8);
  assert.equal(updateCivetMonitorZoom(zoom, snapshot, false).seconds, 20);
  snapshot = civetLiveSnapshot({ latest: row(19), history: [row(19)] });
  const wide = updateCivetMonitorZoom(zoom, snapshot);
  assert.equal(wide.seconds, 20); assert.equal(wide.max, zoom.max);
  assert.equal(updateCivetMonitorZoom(wide, civetLiveSnapshot({ latest: row(20, 9, { usable: false }), history: [] })).seconds, 20);
});
test('adjacent complete windows determine progression independently of graph zoom', () => {
  const history = Array.from({ length: 601 }, (_, i) => row(i / 10, i < 300 ? .5 : 1));
  const snapshot = civetLiveSnapshot({ latest: history.at(-1), history });
  assert.equal(snapshot.average, 1); assert.equal(snapshot.trend, .5);
});
