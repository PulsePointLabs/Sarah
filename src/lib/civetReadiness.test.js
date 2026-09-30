import test from 'node:test';
import assert from 'node:assert/strict';
import {createCivetProcessor,civetEvidence} from './civet.js';
function rig(){const p=createCivetProcessor();let t=0;const feed=(v,n=1)=>{let r;for(let i=0;i<n;i++){r=p.ingest(typeof v==='function'?v(i):v,t);t=Math.round((t+.1)*10)/10;}return r;};p.calibrate('baseline');feed(22.24,51);p.calibrate('reference');feed(27.05,51);feed(22.24,40);return {p,feed,get t(){return t;}};}
test('small post-hold settling cannot permanently poison calibration',()=>{const {feed}=rig();const row=feed(21.89,600);assert.equal(row.usable,true);assert.equal(row.level_pct,0);});
test('brief missing packet recovers without pretending the missing interval is measured',()=>{const r=rig();const gap=r.p.ingest(22.24,r.t+.3);assert.equal(gap.gap,true);assert.equal(gap.acquisition_state,'recovering');assert.equal(gap.usable,false);let out;for(let i=1;i<=40;i++)out=r.p.ingest(22.24,r.t+.3+i*.1);assert.equal(out.usable,true);});
test('persistent drift warns and suppresses intensity but still resolves pressure pulses',()=>{const r=rig();r.feed(20,220);let row;for(let j=0;j<6;j++)row=r.feed(i=>20+Math.sin(Math.PI*i/10),11);assert.equal(row.usable,false);assert.ok(row.contractions_60s>=5);assert.equal(civetEvidence(row).contribution,0);assert.ok(['checking','recalibrate'].includes(row.acquisition_state));assert.equal(r.feed(22.24,140).usable,true);});
test('reconnect requires a deliberate rest/hold even after pressure returns',()=>{const r=rig();let row=r.p.ingest(22.24,r.t,{reconnected:true});for(let i=1;i<100;i++)row=r.p.ingest(22.24,r.t+i*.1);assert.equal(row.acquisition_state,'recalibrate');assert.equal(row.usable,false);});
test('settling times out visibly if the reference hold never releases',()=>{const p=createCivetProcessor();let row;p.calibrate('baseline');for(let i=0;i<51;i++)p.ingest(2,i/10);p.calibrate('reference');for(let i=51;i<410;i++)row=p.ingest(4,i/10);assert.equal(row.acquisition_state,'recalibrate');assert.match(row.acquisition_message,/did not settle/);});

test('a verified comfortable reference remains valid through minutes of stronger sustained pressure',()=>{
  const {feed}=rig();
  const row=feed(i=>28+Math.sin(i/3)*.5,1800);
  assert.equal(row.acquisition_state,'ready');assert.equal(row.usable,true);
  assert.ok(row.level_pct>100);assert.ok(row.duration_s>170);
  assert.ok(row.contraction_count>20);assert.ok(civetEvidence(row).contribution>0);
  assert.ok(Math.abs(row.calibration.baseline-22.24)<1e-9);assert.ok(!row.quality_flags.includes('calibration_invalidated'));
  assert.equal(feed(22.24,60).acquisition_state,'ready');
});

test('calibration cannot report complete before rest, hold and stable release all pass',()=>{
  const p=createCivetProcessor();let t=0;const feed=(v,n)=>{let r;for(let i=0;i<n;i++)r=p.ingest(v,t++/10);return r;};
  p.calibrate('baseline');let r=feed(2,51);assert.equal(r.calibration_valid,false);
  p.calibrate('reference');r=feed(4,51);assert.equal(r.acquisition_state,'settling');assert.equal(r.calibration_valid,false);
  r=feed(4,100);assert.equal(r.acquisition_state,'settling');assert.doesNotMatch(r.calibration_status.message,/complete|ready/i);
  r=feed(2,20);assert.equal(r.calibration_valid,false);
  r=feed(2,20);assert.equal(r.calibration_valid,true);assert.equal(r.acquisition_state,'ready');
});
