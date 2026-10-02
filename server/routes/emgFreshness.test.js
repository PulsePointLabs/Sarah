import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

test('production EMG reader withholds unverified or stale values instead of replaying frozen numbers',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sarah-emg-freshness-'));
  const source=await fs.readFile(new URL('./liveCapture.js',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('async function readEmgTextTelemetry()'),source.indexOf('function startEmgPolling()'));
  const events=[],ingested=[];
  const state={emg:{},session:{active:false}};
  const context=vm.createContext({fs,path,state,EMG_TEXT_DIR:directory,EMG_COMMAND_STATUS_FILE:path.join(directory,'command.json'),lastEmgSignature:'',
    emgHelper:{status:()=>({running:true})},cleanNumber:v=>v==null||v===''?null:Number(v),broadcast:(type,data)=>events.push({type,data}),
    telemetryEngine:{ingestEmgSample:data=>{ingested.push(data);return {event:{payload:data}};}}});
  vm.runInContext(fn,context);
  try {
    await fs.writeFile(path.join(directory,'emg_left.txt'),'72');
    const setup=async(valid,age=0)=>fs.writeFile(path.join(directory,'emg_setup_status.json'),JSON.stringify({fresh:true,measured_at:Date.now()/1000-age,calibration:{saved:valid,valid,phase:'saved'}}));
    await setup(false);await vm.runInContext('readEmgTextTelemetry()',context);assert.equal(state.emg.latestTelemetry.left_pct,null);assert.equal(ingested.length,0);
    await setup(true);await vm.runInContext('readEmgTextTelemetry()',context);assert.equal(ingested.length,1);assert.equal(state.emg.latestTelemetry.left_pct,72);
    await setup(true,3);await vm.runInContext('readEmgTextTelemetry()',context);assert.equal(state.emg.latestTelemetry.left_pct,null);assert.equal(ingested.length,1);
    assert.ok(events.some(e=>e.data.calibration_valid===false));
  } finally {await fs.rm(directory,{recursive:true,force:true});}
});
