import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createCivetProcessor} from './civet.js';
import {createCivetMonitorSummary} from './civetLiveMonitor.js';

function harness(){
  let state={capture_id:'native',state:'streaming',age_ms:0,enabled:true,connected:true,samples:[]};
  const context=vm.createContext({createCivetProcessor,createCivetMonitorSummary,URL,Date,
    window:{location:{href:'http://localhost/'}},apiUrl:path=>'https://offline.invalid/api'+path,
    registerPlugin:()=>({configure:async()=>{},status:async({after})=>({...state,samples:state.samples.filter(r=>r.sequence>after)})}),
    fetch:()=>{throw Error('Local monitor attempted a network request');},
  });
  const source=fs.readFileSync(new URL('./nativeCivet.js',import.meta.url),'utf8');
  vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nthis.api={status:nativeCivetStatus};',context);
  return {api:context.api,set:patch=>{state={...state,...patch};},row:sequence=>({sequence,capture_id:'native',connection_id:'connection',monotonic_ms:sequence*100,timestamp_ms:Date.now(),pressure_kpa:2})};
}
test('native pressure and history work without any server and duplicate polling is harmless',async()=>{
  const h=harness();h.set({samples:[h.row(1),h.row(2)]});
  const first=await h.api.status();assert.equal(first.latest.pressure_kpa,2);assert.equal(first.history.length,2);
  const second=await h.api.status();assert.equal(second.history.length,2);assert.equal(second.acquisition,'phone');
});
test('Bluetooth connectivity alone cannot show stale samples as live',async()=>{
  const h=harness();h.set({samples:[{...h.row(1),timestamp_ms:Date.now()-10000}],age_ms:10000});
  const stale=await h.api.status();assert.equal(stale.latest,null);assert.equal(stale.history.length,1);
});
test('replayed native calibration events use acquisition order and retain raw timestamps',async()=>{
  const h=harness();const now=Date.now();
  const rows=[{...h.row(1),timestamp_ms:now-6100},
    {...h.row(2),type:'calibration_requested',kind:'baseline',prepare_s:0,timestamp_ms:now-6000}];
  for(let n=3;n<=64;n++)rows.push({...h.row(n),timestamp_ms:now-(64-n)*100});
  h.set({samples:rows});const result=await h.api.status();
  assert.equal(result.latest.baseline_ready,true);
  assert.equal(result.history[0].timestamp_ms,rows[0].timestamp_ms);
  assert.equal(result.latest.timestamp_ms,rows.at(-1).timestamp_ms);
});
