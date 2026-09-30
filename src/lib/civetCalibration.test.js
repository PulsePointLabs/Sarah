import test from 'node:test';
import assert from 'node:assert/strict';
import { createCivetProcessor } from './civet.js';
test('queued Windows notifications with identical receive timestamps do not invalidate rest', () => {
  const p=createCivetProcessor(); p.calibrate('baseline'); let row;
  for(let i=0;i<=50;i++)row=p.ingest(20,(i%10===4?i+1:i)/10);
  assert.equal(row.baseline_ready,true); assert.equal(row.calibration_error,null);
});
test('a genuine outage inside the measurement fails even with enough later samples', () => {
  const p=createCivetProcessor();p.calibrate('baseline');let row;
  for(let i=0;i<=50;i++)row=p.ingest(20,i<20?i/10:2.4+(i-20)*2.6/30);
  assert.equal(row.baseline_ready,false);assert.match(row.calibration_error,/interrupted/);
});
test('delivery gap in preparation does not poison the subsequent complete measurement', () => {
  const p=createCivetProcessor();p.calibrate('baseline',{prepareS:3});p.ingest(20,0);p.ingest(20,1);
  let row;for(let i=0;i<=70;i++)row=p.ingest(20,1+i/10);
  assert.equal(row.baseline_ready,true);
});
function rig() {
  const p = createCivetProcessor(); let t = 0;
  return { p, feed(value, n = 51) { let row; for (let i = 0; i < n; i++) { row = p.ingest(typeof value === 'function' ? value(i) : value, t); t = Math.round((t + .1) * 10) / 10; } return row; } };
}
test('brief rest pressure spike suggests redo, even when mean and SD look stable', () => {
  const r = rig(); r.p.calibrate('baseline');
  const row = r.feed(i => i === 25 ? 2.5 : 2);
  assert.equal(row.calibration_status.phase, 'failed');
  assert.equal(row.baseline_ready, false);
  assert.match(row.calibration_error, /redo rest/);
});
test('early release fails reference but allows a fresh hold with the accepted baseline', () => {
  const r = rig(); r.p.calibrate('baseline'); r.feed(2);
  r.p.calibrate('reference'); const failed = r.feed(i => i < 35 ? 4 : 2);
  assert.equal(failed.calibration_status.phase, 'failed');
  assert.equal(failed.baseline_ready, true); assert.equal(failed.usable, false);
  r.feed(2, 60); r.p.calibrate('reference'); const retry = r.feed(4);
  assert.equal(retry.calibration_status.phase, 'settling'); assert.equal(retry.usable, false); assert.equal(r.feed(2,40).usable,true);
});
test('uneven sustained pressure fails instead of setting a misleading reference', () => {
  const r = rig(); r.p.calibrate('baseline'); r.feed(2);
  r.p.calibrate('reference'); const row = r.feed(i => 3 + i / 25);
  assert.equal(row.calibration_status.phase, 'failed'); assert.match(row.calibration_error, /varied/);
});
test('live progress is sample-timed, changes color on instability, and reconnect requires rest', () => {
  const r = rig(); r.p.calibrate('baseline'); const row = r.feed(2, 21);
  assert.equal(row.calibration_remaining_s, 3); assert.equal(row.calibration_status.tone, 'good');
  assert.equal(r.feed(3, 1).calibration_status.tone, 'warning');
  r.p.calibrate('baseline'); r.feed(2); r.p.invalidate();
  assert.throws(() => r.p.calibrate('reference'), /baseline first/);
});
test('preparation allows building a hold without invalidating baseline and is excluded from measurement', () => {
  const r = rig(); r.p.calibrate('baseline'); r.feed(2);
  r.p.calibrate('reference', {prepareS:3});
  const prep = r.feed(i => 2 + i / 15, 30);
  assert.equal(prep.calibration_status.phase, 'preparing'); assert.equal(prep.baseline_ready, true);
  const result = r.feed(4, 51);
  assert.equal(result.usable, false); assert.equal(result.acquisition_state,'settling'); assert.equal(result.calibration.reference, 2); assert.equal(r.feed(2,40).usable,true);
});
