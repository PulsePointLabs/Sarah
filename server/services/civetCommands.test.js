import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';
import {createCivetService} from './civet.js';
import {civetCsv} from '../../src/lib/civetExport.js';
test('hardware zero is explicit, acknowledged, logged, and attached to the next session',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'civet-zero-'));let current=null,command=null;
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
 child.stdin={write:(line,done)=>{command=JSON.parse(line);done?.();}};
 const python=path.join(directory,'python',process.platform==='win32'?'Scripts/python.exe':'bin/python');fs.mkdirSync(path.dirname(python),{recursive:true});fs.writeFileSync(python,'');
 try{const service=createCivetService({directory,session:()=>current,launch:()=>child});await service.connect({address:'AA:BB:CC:DD:EE:FF'});
 service.ingest({pressure_kpa:2,timestamp_ms:1000,monotonic_ms:1000,sequence:1,raw_pressure_integer:200,raw_packet_hex:'d000000000000000c800',connection_id:1});
 await assert.rejects(service.zero({}),/deflated/);assert.equal(command,null);
 const done=service.zero({deflated:true});assert.equal(command.action,'zero');
 child.stdout.emit('data',Buffer.from(JSON.stringify({command_id:command.command_id,success:true,timestamp_ms:1100,command_hex:'66000000000000000000000002'})+'\n'));await done;
 assert.equal(service.status().latest.usable,false);
 current={id:'session',startedAt:new Date(2000).toISOString()};
 service.ingest({pressure_kpa:2,timestamp_ms:2200,monotonic_ms:2200,sequence:2,raw_pressure_integer:200,raw_packet_hex:'d000000000000000c800',connection_id:1});
 const row=service.samples('session')[0];assert.equal(row.t,.2);assert.equal(row.monotonic_ms,2200);assert.equal(row.raw_pressure_integer,200);assert.equal(row.raw_packet_hex,'d000000000000000c800');
 const metadata=service.analysis('session').metadata;assert.ok(metadata.some(e=>e.type==='preceding_hardware_zero'&&e.t===-.9));
 const failed=service.zero({deflated:true});child.stdout.emit('data',Buffer.from(JSON.stringify({command_id:command.command_id,success:false,error:'BLE rejected'})+'\n'));await assert.rejects(failed,/BLE rejected/);
 const interrupted=service.zero({deflated:true});service.disconnect();await assert.rejects(interrupted,/disconnected/);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('CSV escapes event flags and calibration JSON without losing fields',()=>{
 const rows=[{peak:1.2,flags:['one','two'],calibration:{baseline:2,quality:'valid'},note:'a,"b"\nc'}];
 const csv=civetCsv(rows,['peak','flags','calibration','note']);assert.ok(csv.includes('"[""one"",""two""]"'));assert.ok(csv.includes('"a,""b""\nc"'));assert.ok(csv.startsWith('peak,flags,calibration,note\r\n'));
});
