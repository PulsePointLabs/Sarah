import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCivetProcessor } from '../../src/lib/civet.js';
const execute=promisify(execFile);
const helper=fileURLToPath(new URL('../../tools/capture/civet/civet_ble.py',import.meta.url));
export function createCivetService({directory,session=()=>null,onRecorded=()=>{},run=execute,launch=spawn}) {
  const venv=path.join(directory,'python'), python=path.join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python');
  let child=null,busy=false,processor=createCivetProcessor(),history=[],latest=null,lastAt=0,recordingId=null;
  let state={state:'disconnected',error:null,battery:null,address:null};
  const safe=id=>{if(!/^[a-zA-Z0-9_-]{1,150}$/.test(id)) throw new Error('Invalid session id'); return path.join(directory,`${id}.jsonl`);};
  process.once('exit',()=>child?.kill());
  const status=()=>({...state,busy,latest:lastAt && Date.now()-lastAt<1500 ? latest : null,history,age_ms:lastAt?Date.now()-lastAt:null,recordingId});
  function ingest(message) {
    if(!Number.isFinite(message.pressure_kpa)) return;
    const current=session();
    if((current?.id||null)!==recordingId) { processor.reset(); recordingId=current?.id||null; history=[]; }
    const feature=processor.ingest(message.pressure_kpa,message.monotonic_ms/1000);
    const t=current ? (message.timestamp_ms-Date.parse(current.startedAt))/1000 : message.monotonic_ms/1000;
    latest={...feature,t,timestamp_ms:message.timestamp_ms,sequence:message.sequence}; lastAt=Date.now();
    history.push(latest); history=history.filter(p=>t-p.t<=60).slice(-700);
    state.state='connected';state.error=feature.calibration_error||null;
    if(current && t>=0) {
      try {
        fs.mkdirSync(directory,{recursive:true});
        const filename=safe(current.id), first=!fs.existsSync(filename);
        fs.appendFileSync(filename,JSON.stringify(latest)+'\n');
        if(first) onRecorded(current);
      } catch(error) {state.error=`CIVET recording failed: ${error.message}`;}
    }
  }
  return {
    status, ingest,
    samples(id) { const file=safe(id); if(!fs.existsSync(file)) return []; return fs.readFileSync(file,'utf8').split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}); },
    async install() {
      if(child||busy) throw new Error('Disconnect CIVET before installing its helper.'); busy=true;
      try { fs.mkdirSync(directory,{recursive:true}); await run(process.platform==='win32'?'py':'python3',['-m','venv',venv],{windowsHide:true,timeout:60000}); await run(python,['-m','pip','install','-r',path.join(path.dirname(helper),'requirements.txt')],{windowsHide:true,timeout:180000,maxBuffer:1024*1024}); state.error=null; }
      finally {busy=false;} return status();
    },
    async scan() {
      if(busy||child) throw new Error('Disconnect before scanning.');busy=true;
      try { const {stdout}=await run(python,['-u',helper,'scan'],{windowsHide:true,timeout:15000}); return JSON.parse(stdout.trim().split('\n').at(-1)); }
      catch(error) {throw new Error(!fs.existsSync(python)?'Install the CIVET helper first.': /device is not ready|2147020577/i.test(error.message)?'Windows Bluetooth is not ready. Turn Bluetooth on in Windows Settings, then scan again.':error.message.slice(-500));}
      finally {busy=false;}
    },
    async connect({address}) {
      if(child||busy) throw new Error('Disconnect before reconnecting.');
      if(typeof address!=='string'||!/^[a-zA-Z0-9:-]{8,80}$/.test(address)) throw new Error('Choose a discovered CIVET.');
      if(!fs.existsSync(python)) throw new Error('Install the CIVET helper first.');
      processor=createCivetProcessor();latest=null;history=[];lastAt=0;
      state={state:'connecting',address,error:null,battery:null};
      const process=launch(python,['-u',helper,'connect',address],{windowsHide:true,stdio:['ignore','pipe','pipe']});child=process;
      let buffer='';
      process.stdout.on('data',chunk=>{buffer+=chunk.toString();let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const message=JSON.parse(line);if(Number.isFinite(message.pressure_kpa)) ingest(message);else {state={...state,...message};if(message.state==='reconnecting'){latest=null;}}}catch(error){state.error=`CIVET packet error: ${error.message}`;}}});
      process.stderr.on('data',chunk=>{state.error=chunk.toString().slice(-500);});
      process.on('error',error=>{state.error=error.message;state.state='disconnected';if(child===process)child=null;});
      process.on('exit',()=>{if(child===process){child=null;state.state='disconnected';latest=null;}});
      return status();
    },
    disconnect() { child?.kill();child=null;latest=null;state.state='disconnected';return status(); },
    calibrate({kind}) {if(!status().latest)throw new Error('Wait for live pressure samples.');processor.calibrate(kind);return status();},
  };
}
