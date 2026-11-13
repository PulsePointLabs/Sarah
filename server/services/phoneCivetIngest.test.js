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
