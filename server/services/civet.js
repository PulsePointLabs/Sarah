import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CIVET_VERSION, CIVET_PARAMETERS, analyzeCivetReview, linkIntervals, summarizeTrains } from '../../src/lib/civetAnalysis.js';
import { fileURLToPath } from 'node:url';
import { createCivetProcessor } from '../../src/lib/civet.js';
const execute=promisify(execFile);
const helper=fileURLToPath(new URL('../../tools/capture/civet/civet_ble.py',import.meta.url));
export function createCivetService({directory,session=()=>null,onRecorded=()=>{},run=execute,launch=spawn}) {
  const venv=path.join(directory,'python'), python=path.join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python');
  let child=null,busy=false,processor=createCivetProcessor(),history=[],latest=null,lastAt=0,recordingId=null,reconnected=false;
  const pendingCommands=new Map();
  let captureId=randomUUID(),previousConnection=null;
  let lastHardwareZero=null;
  const deviceMetadataFile=path.join(directory,'device','zero-events.jsonl');
  if(fs.existsSync(deviceMetadataFile)){const lines=fs.readFileSync(deviceMetadataFile,'utf8').trim().split('\n').filter(Boolean);try{lastHardwareZero=JSON.parse(lines.at(-1));}catch{lastHardwareZero=null;}}
  let state={state:'disconnected',error:null,battery:null,address:null};
  const safe=id=>{if(!/^[a-zA-Z0-9_-]{1,150}$/.test(id)) throw new Error('Invalid session id'); return path.join(directory,`${id}.jsonl`);};
  process.once('exit',()=>child?.kill());
  const status=()=>({...state,busy,latest:lastAt && Date.now()-lastAt<1500 ? latest : null,history,age_ms:lastAt?Date.now()-lastAt:null,recordingId});
  function appendMetadata(event) {
    const current=session();if(!current)return;
    fs.mkdirSync(directory,{recursive:true});
    fs.appendFileSync(safe(current.id).replace('.jsonl','.metadata.jsonl'),JSON.stringify({...event,t:(event.timestamp_ms-Date.parse(current.startedAt))/1000})+'\n');
    onRecorded(current);
  }
  function samples(id) {
    const file=safe(id);if(!fs.existsSync(file))return [];
    return fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map((line,i)=>{
      try{return JSON.parse(line);}catch{throw new Error(`CIVET recording has an unreadable row at line ${i+1}; original file preserved.`);}
    });
  }
  function analysis(id) {
    const rows=samples(id),file=safe(id),active=session()?.id===id;
    const hash=createHash('sha256').update(fs.existsSync(file)?fs.readFileSync(file):'').digest('hex');
    const metadataFile=file.replace('.jsonl','.metadata.jsonl');
    const metadata=fs.existsSync(metadataFile)?fs.readFileSync(metadataFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
    const liveEvents=linkIntervals(rows.flatMap(r=>r.events||[]));
    const result={raw_sha256:hash,algorithm:CIVET_VERSION,parameters:CIVET_PARAMETERS,active,metadata,
      live:{mode:'live',algorithm:rows[0]?.algorithm||'unknown',events:liveEvents,trains:summarizeTrains(liveEvents,rows)},review:null};
    if(!active&&rows.length) {
      const cache=file.replace('.jsonl',`.${CIVET_VERSION}.${hash.slice(0,16)}.review.json`);
      if(fs.existsSync(cache))result.review=JSON.parse(fs.readFileSync(cache,'utf8'));
      else {result.review={...analyzeCivetReview(rows),raw_sha256:hash};fs.writeFileSync(cache+'.tmp',JSON.stringify(result.review));fs.renameSync(cache+'.tmp',cache);}
    }
    return result;
  }
  function commandReply(message) {
    const pending=pendingCommands.get(message.command_id);
    if(pending){clearTimeout(pending.timer);pendingCommands.delete(message.command_id);}
    try {
      if(!message.success)throw new Error(message.error||'Hardware zero failed');
      processor.invalidate();
      if(latest)latest={...latest,usable:false,calibration_valid:false,level_pct:null,evidence:'Hardware zero applied; recalibrate'};
      lastHardwareZero={type:'hardware_zero',address:state.address,timestamp_ms:message.timestamp_ms,command_hex:message.command_hex,status:'BLE write completed; physical zero not independently verified'};
      fs.mkdirSync(path.dirname(deviceMetadataFile),{recursive:true});fs.appendFileSync(deviceMetadataFile,JSON.stringify(lastHardwareZero)+'\n');appendMetadata(lastHardwareZero);
      pending?.resolve(status());
    } catch(error){state.error=error.message;pending?.reject(error);}
  }
  function rejectCommands() {for(const pending of pendingCommands.values()){clearTimeout(pending.timer);pending.reject(new Error('CIVET disconnected before command confirmation.'));}pendingCommands.clear();}
  function ingest(message) {
    if(!Number.isFinite(message.pressure_kpa)) return;
    const current=session();
    if((current?.id||null)!==recordingId) { processor.reset(); recordingId=current?.id||null; history=[]; }
    const t=current ? (message.timestamp_ms-Date.parse(current.startedAt))/1000 : message.monotonic_ms/1000;
    if(previousConnection!=null&&message.connection_id!=null&&previousConnection!==message.connection_id)reconnected=true;
    previousConnection=message.connection_id??previousConnection;
    const feature=processor.ingest(message.pressure_kpa,t,{timestamp_ms:message.timestamp_ms,reconnected});reconnected=false;
    feature.events=feature.events.map(e=>({...e,id:`${captureId}-${e.id}`,segment:`${captureId}-${e.segment}`,peak_timestamp_ms:message.timestamp_ms+(e.peak-t)*1000}));
    latest={...feature,capture_id:captureId,t,timestamp_ms:message.timestamp_ms,monotonic_ms:message.monotonic_ms,sequence:message.sequence,raw_packet_hex:message.raw_packet_hex??null,raw_pressure_integer:message.raw_pressure_integer??null,connection_id:message.connection_id??null}; lastAt=Date.now();
    history.push(latest); history=history.filter(p=>t-p.t<=60).slice(-700);
    state.state='connected';state.error=feature.calibration_error||null;
    if(current && t>=0) {
      try {
        fs.mkdirSync(directory,{recursive:true});
        const filename=safe(current.id), first=!fs.existsSync(filename);
        fs.appendFileSync(filename,JSON.stringify(latest)+'\n');
        if(first) {
          appendMetadata({type:'capture_started',timestamp_ms:message.timestamp_ms,calibration:feature.calibration,algorithm:CIVET_VERSION,clock:'host monotonic anchored UTC; t relative to Sarah session start'});
          if(lastHardwareZero&&lastHardwareZero.address===state.address)appendMetadata({...lastHardwareZero,type:'preceding_hardware_zero'});
        }
        if(feature.calibration_event)appendMetadata(feature.calibration_event);
      } catch(error) {state.error=`CIVET recording failed: ${error.message}`;}
    }
  }
  return {
    status, ingest,
    samples, analysis,
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
      captureId=randomUUID();previousConnection=null;processor=createCivetProcessor();latest=null;history=[];lastAt=0;
      state={state:'connecting',address,error:null,battery:null};
      const process=launch(python,['-u',helper,'connect',address],{windowsHide:true,stdio:['pipe','pipe','pipe']});child=process;
      let buffer='';
      process.stdout.on('data',chunk=>{buffer+=chunk.toString();let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const message=JSON.parse(line);if(message.command_id) {commandReply(message);}else if(Number.isFinite(message.pressure_kpa)) ingest(message);else {state={...state,...message};if(message.state==='reconnecting'){latest=null;reconnected=true;processor.invalidate();}}}catch(error){state.error=`CIVET packet error: ${error.message}`;}}});
      process.stderr.on('data',chunk=>{state.error=chunk.toString().slice(-500);});
      process.on('error',error=>{state.error=error.message;state.state='disconnected';if(child===process)child=null;});
      process.on('exit',()=>{if(child===process){rejectCommands();child=null;state.state='disconnected';latest=null;}});
      return status();
    },
    async zero({deflated}) {
      if(deflated!==true)throw new Error('Confirm CIVET is deflated and outside the body before zeroing.');
      if(!child||!status().latest)throw new Error('Connect CIVET and wait for pressure samples first.');
      if(pendingCommands.size)throw new Error('A CIVET command is already in progress.');
      const command_id=`zero-${randomUUID()}`;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pendingCommands.delete(command_id);reject(new Error('No hardware-zero acknowledgement. Check the sensor before retrying.'));},5000);
        pendingCommands.set(command_id,{resolve,reject,timer});
        child.stdin.write(JSON.stringify({action:'zero',command_id})+'\n',error=>{if(error){clearTimeout(timer);pendingCommands.delete(command_id);reject(error);}});
      });
    },
    disconnect() { rejectCommands();child?.kill();child=null;latest=null;state.state='disconnected';return status(); },
    calibrate({kind}) {if(!status().latest)throw new Error('Wait for live pressure samples.');processor.calibrate(kind);return status();},
  };
}
