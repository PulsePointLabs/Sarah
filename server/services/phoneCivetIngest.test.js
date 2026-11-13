import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createPhoneCivetIngest } from './phoneCivetIngest.js';
import {createCivetService} from './civet.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const reading=(sequence=1)=>({timestamp_ms:Date.now()-10000,monotonic_ms:sequence*100,sequence,connection_id:'test',pressure_kpa:2.5});
test('phone copies are durable and idempotent, including ordered calibration events',()=>{
  const db=new Database(':memory:'),seen=[];
  const receive=createPhoneCivetIngest(db,row=>seen.push(row));
  const packets=[{id:'fixture-packet-1',reading:reading()},
    {id:'fixture-event-2',reading:{...reading(2),pressure_kpa:undefined,type:'calibration_requested',kind:'baseline',prepare_s:3}},
    {id:'fixture-packet-3',reading:reading(3)}];
  assert.deepEqual(receive(packets).acknowledged,packets.map(p=>p.id));
  receive(packets);
  assert.equal(db.prepare('SELECT count(*) AS n FROM phone_civet_packets').get().n,3);
  assert.deepEqual(seen.map(r=>r.sequence),[1,2,3]);
  assert.equal(seen[0].timestamp_ms,packets[0].reading.timestamp_ms);
  db.close();
});
test('a malformed batch cannot partially acknowledge or store measurements',()=>{
  const db=new Database(':memory:');const receive=createPhoneCivetIngest(db,()=>{});
  assert.throws(()=>receive([{id:'fixture-good',reading:reading()},{id:'fixture-bad',reading:{...reading(2),pressure_kpa:null}}]),/Invalid/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM phone_civet_packets').get().n,0);
  db.close();
});
test('server backfill never presents an old phone sample as live pressure',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'phone-civet-'));
  try {
    const service=createCivetService({directory});
    service.ingestPhone(reading());
    assert.equal(service.status().latest,null);
    service.ingestPhone({...reading(2),timestamp_ms:Date.now()});
    assert.equal(service.status().latest.pressure_kpa,2.5);
    assert.equal(service.status().acquisition,'phone');
  }finally{assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true});}
});
test('explicit server acquisition is preserved while phone copies remain archived',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'phone-civet-'));
  try {
    const service=createCivetService({directory});
    service.source({source:'server'});
    service.ingestPhone({...reading(),timestamp_ms:Date.now()});
    assert.equal(service.status().acquisition,'server');assert.equal(service.status().latest,null);
    service.source({source:'phone'});
    service.ingestPhone({...reading(2),timestamp_ms:Date.now()});
    assert.equal(service.status().latest.pressure_kpa,2.5);
    assert.equal(service.status().acquisition,'phone');
  }finally{assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true});}
});
test('Chrome calibration of a phone stream waits for acquisition events rather than changing only the server',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'phone-civet-control-'));
  try {
    const commands=[];const service=createCivetService({directory,phoneCommand:async(capture,action,body)=>{commands.push({capture,action,body});}});
    let sequence=0,t=0;
    const feed=(extra={})=>service.ingestPhone({...reading(++sequence),capture_id:'capture-test',monotonic_ms:(t+=100),timestamp_ms:Date.now(),...extra});
    feed();await service.calibrate({kind:'baseline',prepare_s:3});
    assert.equal(commands[0].capture,'capture-test');assert.equal(commands[0].body.kind,'baseline');
    assert.equal(service.status().latest.baseline_ready,false);
    feed({type:'calibration_requested',kind:'baseline',prepare_s:0});
    for(let i=0;i<52;i++)feed();
    assert.equal(service.status().latest.baseline_ready,true);
    assert.equal(service.status().latest.calibration.baseline,2.5);
    await service.zero({deflated:true});assert.equal(commands[1].action,'zero');
    feed({type:'hardware_zero'});feed();assert.equal(service.status().latest.baseline_ready,false);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('the phone stream choice survives a server restart instead of reverting to downstairs Bluetooth',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'phone-civet-source-'));
  try {
    createCivetService({directory}).source({source:'phone'});
    const restarted=createCivetService({directory});await restarted.resume();
    assert.equal(restarted.status().acquisition,'phone');assert.equal(restarted.status().state,'waiting_for_phone');
    restarted.source({source:'server'});assert.equal(createCivetService({directory}).status().acquisition,'server');
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
