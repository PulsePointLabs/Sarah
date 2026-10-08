import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {parse} from 'csv-parse/sync';

test('CIVET HTTP history and all exports preserve raw values and distinguish analysis modes',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'civet-http-'));
  process.env.DATA_DIR=directory;process.env.DATABASE_PATH=path.join(directory,'test.sqlite');
  const {createCivetRouter}=await import('./civet.js');
  const {db}=await import('../db.js');
  let active=null;
  const rows=Array.from({length:200},(_,i)=>({t:i/10,pressure_kpa:2+Math.max(0,Math.sin(i/10*2*Math.PI)),usable:true,calibration:{baseline:2,noise:.01,reference:2,at:0},algorithm:'civet-pressure-v1'}));
  fs.mkdirSync(path.join(directory,'civet'));
  fs.writeFileSync(path.join(directory,'civet','session.jsonl'),rows.map(JSON.stringify).join('\n')+'\n');
  const app=express();app.use(express.json());app.use('/api/civet',createCivetRouter(()=>active));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const url=`http://127.0.0.1:${server.address().port}/api/civet`;
  try {
    const data=await (await fetch(`${url}/session/session`)).json();assert.deepEqual(data.samples,rows);assert.ok(data.analysis.review.events.length>10);
    const {unpackCivetTimeline}=await import('../../src/lib/civetTimelineTransport.js');
    const packed=await (await fetch(`${url}/session/session?encoding=columns`)).json();
    assert.equal(packed.encoding,'civet-columns-v1');
    assert.deepEqual(unpackCivetTimeline(packed).samples,data.samples);
    assert.deepEqual(unpackCivetTimeline(packed).analysis,data.analysis);
    for(const kind of ['samples','events','trains']) {
      const response=await fetch(`${url}/session/session/export?kind=${kind}&mode=review`);assert.equal(response.status,200);
      const parsed=parse(await response.text(),{columns:true});assert.ok(parsed.length>0);
      if(kind==='samples')assert.equal(Number(parsed[20].pressure_kpa),rows[20].pressure_kpa);
      if(kind==='events'){assert.ok(parsed[0].algorithm.includes('morphology'));assert.ok(Array.isArray(JSON.parse(parsed[0].flags)));}
    }
    const exported=await (await fetch(`${url}/session/session/export?kind=analysis&mode=review`)).json();assert.equal(exported.raw_sha256,data.analysis.raw_sha256);
    active={id:'session'};assert.equal((await fetch(`${url}/session/session/export?kind=events&mode=review`)).status,400);
    assert.equal((await fetch(`${url}/session/session/export?kind=events&mode=live`)).status,200);
    assert.equal((await fetch(`${url}/zero`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,400);
    assert.equal((await (await fetch(`${url}/session/absent`)).json()).samples.length,0);
  } finally {await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(directory,{recursive:true,force:true});}
});
