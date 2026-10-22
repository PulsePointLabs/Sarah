import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'sarah-bp-ingest-'));
process.env.DATABASE_PATH=path.join(temp,'test.sqlite');
const {db,initDb,upsertEntity,getEntity,listEntities}=await import('../db.js');initDb();
const {bloodPressureRouter,setBloodPressureCaptureResolver}=await import('./bloodPressure.js');
const app=express();app.use(express.json());app.use(bloodPressureRouter);
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
const ingest=async reading=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/ingest`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({readings:[reading]})});return {status:r.status,data:await r.json()};};
test('direct APK BP is attached atomically for Body Exploration and Session; retries do not duplicate',async()=>{
 for(const entity of ['BodyExploration','Session']) {
  const start=Date.now()-60000;const id=entity;
  upsertEntity(entity,id,{capture_started_at:new Date(start).toISOString(),event_timeline:[{id:'existing',time_s:1,note:'keep'}]});
  setBloodPressureCaptureResolver(()=>({id,entity,startedAt:new Date(start).toISOString()}));
  const reading={external_id:entity,session:id,measured_at:new Date(start+45000).toISOString(),received_at:new Date(start+45000).toISOString(),timestamp_source:'cuff_clock',source_app:'OMRON BP7000 native BLE',systolic_mm_hg:140,diastolic_mm_hg:104};
  const result=await ingest(reading);assert.equal(result.status,200);
  const saved=getEntity(entity,id);assert.equal(saved.event_timeline.length,2);
  assert.equal(saved.event_timeline[1].time_s,45);assert.equal(saved.latest_blood_pressure_reading.timestamp_source,'cuff_clock');
  assert.ok(result.data.readings[0].server_received_at);
  await ingest(reading);assert.equal(getEntity(entity,id).event_timeline.length,2);
 }
});
test('historical readings and readings explicitly belonging to another capture are not attached',async()=>{
 const start=Date.now()-60000;upsertEntity('Session','new',{capture_started_at:new Date(start).toISOString()});
 setBloodPressureCaptureResolver(()=>({id:'new',entity:'Session',startedAt:new Date(start).toISOString()}));
 for(const reading of [{external_id:'historical',measured_at:new Date(start-60000).toISOString()},{external_id:'other',session:'old',measured_at:new Date().toISOString()}]) await ingest({...reading,source_app:'OMRON native BLE',systolic_mm_hg:120,diastolic_mm_hg:80});
 assert.equal(getEntity('Session','new').event_timeline,undefined);
 assert.equal(listEntities('BloodPressureReading').length,4);
});
test('attachment failure rolls back ingestion, so the APK can safely retry',async()=>{
 setBloodPressureCaptureResolver(()=>{throw Error('attachment unavailable');});
 const result=await ingest({external_id:'failure',measured_at:new Date().toISOString(),systolic_mm_hg:120,diastolic_mm_hg:80});
 assert.equal(result.status,500);assert.equal(getEntity('BloodPressureReading','bp-failure'),null);
});
test('uncertain reception times, post-recording readings and pause readings remain in history without session attachment',async()=>{
 const start=Date.now()-120000,end=start+60000;
 upsertEntity('Session','bounded',{capture_started_at:new Date(start).toISOString(),capture_finalized_at:new Date(end).toISOString(),capture_pause_intervals:[{pausedAt:new Date(start+20000).toISOString(),resumedAt:new Date(start+30000).toISOString()}]});
 setBloodPressureCaptureResolver(()=>({id:'bounded',entity:'Session',startedAt:new Date(start).toISOString()}));
 for(const [key,at,source] of [['uncertain',start+10000,'received_at'],['paused',start+25000,'cuff_clock'],['after',end+1000,'cuff_clock'],['before',start-1,'cuff_clock']]) {
  const result=await ingest({external_id:key,measured_at:new Date(at).toISOString(),timestamp_source:source,source_app:'OMRON native BLE',systolic_mm_hg:120,diastolic_mm_hg:80});
  assert.equal(result.status,200);assert.ok(getEntity('BloodPressureReading',`bp-${key}`));
 }
 assert.equal(getEntity('Session','bounded').event_timeline,undefined);
 const result=await ingest({external_id:'valid-delayed',measured_at:new Date(start+40000).toISOString(),timestamp_source:'cuff_clock',source_app:'OMRON native BLE',systolic_mm_hg:120,diastolic_mm_hg:80});
 assert.equal(result.status,200);assert.equal(getEntity('Session','bounded').event_timeline.length,1);
});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(temp,{recursive:true,force:true});});
