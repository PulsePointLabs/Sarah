import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createCivetService} from './civet.js';

function fixture() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'civet-remember-'));
  const python=path.join(directory,'python',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  fs.mkdirSync(path.dirname(python),{recursive:true});fs.writeFileSync(python,'');
  const children=[];
  const launch=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>child.emit('exit');children.push(child);return child;};
  const make=()=>createCivetService({directory,launch});
  const send=(child,message)=>child.stdout.emit('data',JSON.stringify(message)+'\n');
  return {directory,children,make,send,clean:()=>fs.rmSync(directory,{recursive:true,force:true})};
}
const address='AA:BB:CC:DD:EE:FF';

test('remembers only a successful connection and resumes once after service restart without old calibration',async()=>{
  const f=fixture();try {
    const first=f.make();await first.connect({address});assert.equal(first.status().remembered,null);
    const child=f.children[0];child.stdout.emit('data','{"state":"con');child.stdout.emit('data','nected"}\n');
    assert.deepEqual(first.status().remembered,{address,autoReconnect:true});first.disconnect();
    const restarted=f.make();await Promise.all([restarted.resume(),restarted.resume()]);
    assert.equal(f.children.length,2);assert.equal(restarted.status().address,address);assert.equal(restarted.status().latest,null);
    f.send(f.children[1],{state:'connected'});
    restarted.ingest({pressure_kpa:2,timestamp_ms:Date.now(),monotonic_ms:1000,connection_id:1});
    assert.equal(restarted.status().latest.calibration_valid,false);
    restarted.disconnect();await restarted.resume();assert.equal(f.children.length,2);
    await restarted.connect({address});assert.equal(f.children.length,3);restarted.disconnect();
  } finally {f.clean();}
});

test('opt out persists, forget survives reconnect messages, and stale process output is ignored',async()=>{
  const f=fixture();try {
    const service=f.make();await service.connect({address});f.send(f.children[0],{state:'connected'});
    service.remember({enabled:false});service.disconnect();await f.make().resume();assert.equal(f.children.length,1);
    await service.connect({address});f.send(f.children[0],{state:'connected',battery:99});assert.equal(service.status().state,'connecting');
    service.remember({forget:true});f.send(f.children[1],{state:'connected'});assert.equal(service.status().remembered,null);
    assert.equal(f.make().status().remembered,null);service.disconnect();
  } finally {f.clean();}
});

test('bad saved preferences and missing helper fall back to visible manual setup',async()=>{
  const f=fixture();try {
    const file=path.join(f.directory,'device','connection.json');fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,'{"address":"../invalid"}');const invalid=f.make();await invalid.resume();assert.equal(f.children.length,0);
    fs.writeFileSync(file,JSON.stringify({address,autoReconnect:true}));fs.rmSync(path.join(f.directory,'python'),{recursive:true});
    const missing=f.make();const status=await missing.resume();assert.match(status.error,/Install the CIVET helper/);assert.equal(f.children.length,0);
  } finally {f.clean();}
});
