import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCivetProcessor, civetAt, civetEvidence, withCivetEvidence } from '../../src/lib/civet.js';
import { createCivetService } from './civet.js';
function calibrated() {const p=createCivetProcessor();let t=0;const feed=(v,n)=>{let row;for(let i=0;i<n;i++){row=p.ingest(v,t);t+=.1;}return row;};p.calibrate('baseline');feed(2,52);p.calibrate('reference');feed(4,52);feed(2,40);return {p,feed};}
test('calibration preserves raw pressure and yields causal pulse and hold evidence',()=>{const {feed}=calibrated();feed(2,10);let row=feed(3,35);assert.equal(row.pressure_kpa,3);assert.equal(row.delta_kpa,1);assert.equal(row.level_pct,50);assert.equal(row.evidence,'sustained contraction');row=feed(2,5);assert.equal(row.contraction_count,1);assert.ok(row.mean_duration_s>=3);});
test('three resolved pulses yield rhythm; gaps suppress evidence and stale lookup',()=>{const {p,feed}=calibrated();feed(2,10);for(let i=0;i<3;i++){for(const value of [2.1,2.4,2.8,3,2.8,2.4,2.1,2,2,2,2])feed(value,1);}const row=feed(2,1);assert.equal(row.rhythm,true);assert.equal(civetEvidence(row).contribution,8);const gap=p.ingest(3,100);assert.equal(gap.usable,false);assert.equal(gap.rhythm,false);assert.equal(civetAt([{t:1,usable:true}],2),null);});
test('uncalibrated and noisy reference never invent force or support phase',()=>{const p=createCivetProcessor();let row=p.ingest(3,0);assert.equal(row.level_pct,null);assert.equal(civetEvidence(row).contribution,0);p.calibrate('baseline');for(let i=1;i<=52;i++)row=p.ingest(3,i/10);p.calibrate('reference');for(let i=53;i<106;i++)row=p.ingest(3,i/10);assert.equal(row.usable,false);});
test('pelvic contribution is bounded, gated and not double-counted with EMG',()=>{const base={nearClimax:60,recovery:0,buildEligibleForNearClimax:true,reason:'base'};const sample={usable:true,rhythm:true};assert.equal(withCivetEvidence(base,sample).nearClimax,68);assert.equal(withCivetEvidence(base,sample,100).nearClimax,60);assert.equal(withCivetEvidence({...base,buildEligibleForNearClimax:false},sample).nearClimax,60);assert.equal(base.nearClimax,60);});
test('service records every sample to correct session, survives re-open and rejects path traversal',()=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sarah-civet-test-'));try{let current=null,attached=0;const service=createCivetService({directory,session:()=>current,onRecorded:()=>attached++});service.ingest({pressure_kpa:2,timestamp_ms:1000,monotonic_ms:1000});assert.equal(service.samples('session-a').length,0);current={id:'session-a',startedAt:new Date(1000).toISOString()};for(let i=0;i<100;i++)service.ingest({pressure_kpa:2+i/100,timestamp_ms:1000+i*100,monotonic_ms:1000+i*100});assert.equal(service.samples('session-a').length,100);assert.equal(attached,1);assert.equal(service.samples('session-a')[99].t,9.9);assert.equal(createCivetService({directory}).samples('session-a').length,100);current=null;service.ingest({pressure_kpa:4,timestamp_ms:20000,monotonic_ms:20000});assert.equal(service.samples('session-a').length,100);assert.throws(()=>service.samples('../escape'));}finally{fs.rmSync(directory,{recursive:true,force:true});}});

test('analysis preserves original JSONL, distinguishes live/review, and reads legacy sessions',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'civet-review-'));
 try{const rows=Array.from({length:150},(_,i)=>({t:i/10,pressure_kpa:2+Math.max(0,Math.sin(i/10*2*Math.PI)),usable:true,calibration:{baseline:2,noise:.01,reference:2,at:0},algorithm:'civet-pressure-v1'}));
 const file=path.join(directory,'legacy.jsonl');fs.writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');const bytes=fs.readFileSync(file);
 const service=createCivetService({directory});const result=service.analysis('legacy');assert.equal(result.live.events.length,0);assert.ok(result.review.events.length>5);assert.equal(result.review.mode,'review');assert.deepEqual(fs.readFileSync(file),bytes);assert.deepEqual(service.analysis('legacy'),result);assert.deepEqual(service.samples('absent'),[]);
 const active=createCivetService({directory,session:()=>({id:'legacy'})});assert.equal(active.analysis('legacy').review,null);
 fs.appendFileSync(file,'broken\n');assert.throws(()=>service.samples('legacy'),/unreadable row/);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
