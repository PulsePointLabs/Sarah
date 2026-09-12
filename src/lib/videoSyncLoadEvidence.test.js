import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLoadEvidence, loadBandsFromPoints } from './videoSyncLoadEvidence.js';
import { phaseEvidenceAt } from './videoSyncPhaseEvidence.js';
const rows = Array.from({length: 160}, (_, t) => ({time_offset_s:t, hr:t<30?80:t<110?110:Math.max(80,110-(t-110)), baseline_hr:80, hrv_rmssd_ms:t<30?40:20, hrv_quality:'high'}));
test('load follows elevation and settling, without climax labels', () => {
 const model=buildLoadEvidence(rows);
 assert.equal(phaseEvidenceAt(model.points,20).load,0);
 assert.ok(phaseEvidenceAt(model.points,100).load>=65);
 assert.equal(phaseEvidenceAt(model.points,130).phase,'recovery');
 assert.doesNotMatch(JSON.stringify(model.moments)+JSON.stringify(loadBandsFromPoints(model.points)),/climax/i);
});
test('load is causal, missing evidence stays unknown, gaps restart warmup', () => {
 const full=buildLoadEvidence(rows), prefix=buildLoadEvidence(rows.slice(0,80));
 assert.deepEqual(full.points.slice(0,80),prefix.points);
 assert.equal(buildLoadEvidence([{time_offset_s:0,hr:80}]).points[0].load,null);
 assert.equal(phaseEvidenceAt(full.points,200).phase,'unavailable');
 const gap=buildLoadEvidence([...rows.slice(0,30),...rows.slice(60)]);
 assert.equal(gap.points.find(p=>p.t===60).load,null);
});

test('interleaved partial packets do not continually restart warmup or erase HRV', () => {
 const packets = rows.flatMap(r => [
  {...r, baseline_hr:0},
  {...r, time_offset_s:r.time_offset_s+.001},
  {...r, time_offset_s:r.time_offset_s+.003, hrv_rmssd_ms:0, hrv_quality:'unavailable'},
 ]);
 const model=buildLoadEvidence(packets);
 const current=phaseEvidenceAt(model.points,106);
 assert.notEqual(current.phase,'warming');
 assert.ok(Number.isFinite(current.load));
 assert.equal(current.hrvUsable,true);
 assert.ok(current.reference>0);
 assert.deepEqual(model.points.filter(p=>p.t<80),buildLoadEvidence(packets.filter(r=>r.time_offset_s<80)).points);
});
test('simultaneous partial records merge and expired baseline still stops scoring', () => {
 const packets=rows.flatMap(r=>[{...r,baseline_hr:0},r,{...r,hrv_quality:'unavailable',hrv_rmssd_ms:0}]);
 assert.ok(phaseEvidenceAt(buildLoadEvidence(packets).points,80).load>0);
 const missing=rows.map(r=>r.time_offset_s>60?{...r,baseline_hr:0}:r);
 assert.equal(phaseEvidenceAt(buildLoadEvidence(missing).points,80).phase,'unavailable');
});
