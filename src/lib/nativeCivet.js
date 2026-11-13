import { registerPlugin } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { createCivetProcessor } from './civet.js';
import { createCivetMonitorSummary } from './civetLiveMonitor.js';
import { apiUrl } from './mobileApiBase.js';

const plugin=registerPlugin('SarahCivet');
let processor=createCivetProcessor(), summarize=createCivetMonitorSummary();
let history=[],latest=null,captureId='',connectionId='',after=0,journalAfter=0,summary=null,remembered=null;
let snapshot={state:'disconnected',history:[],latest:null,acquisition:'phone',recordingId:null};
let pending;
let configured='';
export async function followPhoneCivet() {
  // An explicit phone connection also selects that stream for Chrome. Failure
  // here must never prevent offline/local Bluetooth acquisition.
  try {await fetch(apiUrl('/civet/source'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:'phone'}),signal:AbortSignal.timeout(2500)});}catch{/* Server copy is optional. */}
}
export async function nativeCivetStatus() {
  if(pending)return pending;
  pending=(async()=>{
    const endpoint=new URL(apiUrl('/civet/phone-ingest'),window.location.href).href;
    if(endpoint!==configured){await plugin.configure({endpoint});configured=endpoint;}
    let state=await plugin.status({after,journalAfter});
    if(state.capture_id!==captureId) {
      captureId=state.capture_id;connectionId='';after=0;journalAfter=0;history=[];latest=null;processor=createCivetProcessor();summarize=createCivetMonitorSummary();
      state=await plugin.status({after:0,journalAfter:0});
    }
    for(const row of state.samples||[]) {
      if(row.sequence<=after)continue;
      after=row.sequence;
      if(row.type==='calibration_requested'){processor.calibrate(row.kind,{prepareS:row.prepare_s});continue;}
      if(row.type==='hardware_zero'){processor.invalidate();continue;}
      const reconnected=Boolean(connectionId&&connectionId!==row.connection_id);
      connectionId=row.connection_id;
      const feature=processor.ingest(row.pressure_kpa,row.monotonic_ms/1000,{timestamp_ms:row.timestamp_ms,reconnected});
      latest={...row,...feature,capture_id:captureId,t:row.monotonic_ms/1000};
      latest.events=feature.events.map(e=>({...e,id:`${captureId}-${e.id}`,segment:`${captureId}-${e.segment}`}));
      summary=summarize(latest);history.push(latest);after=row.sequence;
    }
    journalAfter=state.journal_cursor??journalAfter;
    history=history.filter(row=>latest&&latest.t-row.t<=60).slice(-1200);
    if(state.address)remembered={address:state.address,autoReconnect:state.enabled};
    snapshot={...state,state:state.state==='streaming'?'connected':state.state,history,latest:state.age_ms!=null&&state.age_ms<1500&&Date.now()-latest?.timestamp_ms<1500?latest:null,
      monitorSummary:summary,remembered,acquisition:'phone',recordingId:null,localRecording:state.enabled,localSaved:state.localSaved};
    return snapshot;
  })();
  try{return await pending;}finally{pending=null;}
}
export async function nativeCivetRequest(action,body={}) {
  if(action==='status'||action==='resume')return nativeCivetStatus();
  if(action==='scan') {
    await BleClient.initialize({androidNeverForLocation:true});
    const device=await BleClient.requestDevice({namePrefix:'47L124'});
    return {devices:[{address:device.deviceId,name:device.name||'CIVET'}]};
  }
  if(action==='connect') {await plugin.connect({deviceId:body.address});await followPhoneCivet();return nativeCivetStatus();}
  if(action==='disconnect') {await plugin.disconnect();return nativeCivetStatus();}
  if(action==='calibrate') {
    if(!snapshot.latest)throw Error('Wait for live phone pressure samples first.');
    if(body.kind==='reference'&&!snapshot.latest.baseline_ready)throw Error('Collect rest first.');
    await plugin.calibrate({kind:body.kind,prepare_s:body.prepare_s||0});return nativeCivetStatus();
  }
  if(action==='zero') {
    await plugin.zero({deflated:body.deflated});return nativeCivetStatus();
  }
  if(action==='remember') {
    if(body.forget||body.enabled===false) {await plugin.disconnect();remembered=null;}
    else if(remembered)await plugin.connect({deviceId:remembered.address});
    return nativeCivetStatus();
  }
  throw Error('Phone acquisition is built into Sarah; no desktop helper is required.');
}
