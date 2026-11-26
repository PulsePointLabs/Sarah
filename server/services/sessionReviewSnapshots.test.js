import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadSessionReviewSnapshots} from './sessionReviewSnapshots.js';
import {sessionOutcome,recordedDevices} from '../../src/lib/videoRecordSummary.js';
import {recordFlag} from '../../src/lib/sessionRecordFlags.js';

test('snapshot worker summarizes actual telemetry without altering original records',async()=>{
  const prefix=path.join(os.tmpdir(),'sarah-picker-'),directory=fs.mkdtempSync(prefix),dbPath=path.join(directory,'test.sqlite');
  const db=new Database(dbPath);db.exec('CREATE TABLE entities(entity TEXT,id TEXT,data TEXT,PRIMARY KEY(entity,id))');
  const put=(entity,id,data)=>db.prepare('INSERT INTO entities VALUES(?,?,?)').run(entity,id,JSON.stringify(data));
  const record={id:'real',hr_source_label:'Direct Polar H10',avg_hr:999,capture_started_at:'2026-11-25T00:00:00Z',capture_wall_duration_seconds:60,blood_pressure_readings:[{measured_at:'2026-11-25T00:00:05Z',systolic_mm_hg:120,diastolic_mm_hg:80}],subjective_near_climax_episodes:[{kind:'near_climax',start_s:3,end_s:10}]};
  put('Session','real',record);put('BodyExploration','empty',{id:'empty',civet_enabled:true,emg_enabled:true,latest_blood_pressure_reading:{measured_at:'2026-01-01'}});
  [0,80,100,120,300].forEach((hr,i)=>put('HeartRateTimeline',String(i),{session:'real',hr}));
  fs.writeFileSync(path.join(directory,'real.jsonl'),[{pressure_kpa:2,usable:true},{pressure_kpa:4,usable:true},{pressure_kpa:50,usable:false}].map(row=>JSON.stringify(row)).join('\n'));
  const original=db.prepare('SELECT data FROM entities WHERE id=?').get('real').data;
  try{
    const [snapshot,empty]=await loadSessionReviewSnapshots([{entity:'Session',id:'real'},{entity:'BodyExploration',id:'empty'}],{dbPath,civetDirectory:directory,fresh:true});
    assert.deepEqual(snapshot.heart_rate,{min:80,avg:100,max:120,samples:3});assert.equal(snapshot.pelvic_pressure.avg,3);assert.equal(snapshot.pelvic_pressure.max,4);
    assert.deepEqual(snapshot.devices,['Polar H10','CIVET','BP cuff']);assert.equal(snapshot.outcome.label,'Near-climax marked');
    assert.deepEqual(empty.devices,[]);assert.equal(empty.pelvic_pressure,null);assert.equal(empty.outcome.label,'Body exploration');
    assert.equal(db.prepare('SELECT data FROM entities WHERE id=?').get('real').data,original);
  }finally{db.close();if(directory.startsWith(prefix))fs.rmSync(directory,{recursive:true,force:true});}
});

test('outcome badges use explicit records rather than missing flags or AI likelihood',()=>{
  assert.equal(sessionOutcome({no_climax:0}).label,'Outcome not logged');
  assert.equal(sessionOutcome({climax_offset_s:''}).label,'Outcome not logged');
  assert.equal(sessionOutcome({climax_offset_s:120,no_climax:0}).label,'Climax logged');
  assert.equal(sessionOutcome({climax_duration:12,no_climax:1}).label,'Outcome needs review');
  assert.equal(sessionOutcome({ai_near_climax_events:[{}]}).label,'Outcome not logged');
  assert.deepEqual(recordedDevices({civet_enabled:true,emg_enabled:true,capture_source:'obs'}),[]);
  for(const flag of [0,false,'0','false',null,undefined])assert.equal(recordFlag(flag),false);
});
