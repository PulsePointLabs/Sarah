import test from 'node:test';
import assert from 'node:assert/strict';
import { postBloodPressureReadings } from './bloodPressureTransport.js';
const reading = { external_id:'fixture-cuff', measured_at:'2026-11-03T03:37:00Z', systolic_mm_hg:120, diastolic_mm_hg:80 };
const confirmed = () => Response.json({ok:true,readings:[reading]});

test('a dead server address is rediscovered and the identical reading is retried', async () => {
  let base='http://old/api', discoveries=0; const calls=[];
  const result=await postBloodPressureReadings([reading], {
    url:()=>`${base}/blood-pressure/ingest`, discover:async()=>{discoveries++;base='http://current/api';},
    fetchImpl:async(url,options)=>{calls.push({url,body:options.body});if(calls.length===1)throw new TypeError('offline');return confirmed();},
  });
  assert.equal(discoveries,1);assert.equal(calls[1].url,'http://current/api/blood-pressure/ingest');
  assert.equal(calls[0].body,calls[1].body);assert.equal(result.readings[0].external_id,reading.external_id);
});
test('a hanging request is aborted, allowing discovery and queue retries to continue', async () => {
  let attempts=0;
  await postBloodPressureReadings([reading],{url:()=>'/api/blood-pressure/ingest',timeoutMs:15,discover:async()=>{},
    fetchImpl:async(_url,{signal})=>{if(++attempts===2)return confirmed();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('timeout','AbortError'))));}});
  assert.equal(attempts,2);
});
test('an unrelated successful response cannot acknowledge a cuff reading', async () => {
  await assert.rejects(postBloodPressureReadings([reading],{url:()=>'/api',fetchImpl:async()=>Response.json({ok:true,readings:[{...reading,external_id:'other'}]})}),/did not confirm/);
});
test('validation failures retain their error and do not switch servers', async () => {
  let discoveries=0;
  await assert.rejects(postBloodPressureReadings([reading],{url:()=>'/api',discover:async()=>{discoveries++;},fetchImpl:async()=>Response.json({error:'Invalid measured_at'},{status:400})}),/Invalid measured_at/);
  assert.equal(discoveries,0);
});
