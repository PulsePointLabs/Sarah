import {civetView} from '../lib/civetView.js';
import { useEffect, useState, useMemo } from 'react';
import { apiUrl } from '../lib/mobileApiBase.js';
import { unpackCivetTimeline } from '../lib/civetTimelineTransport.js';
import { isNativeSarah } from '../lib/phoneTelemetry.js';
import { usesNativeCivet, selectCivetSource } from '../lib/civetSource.js';
import { nativeCivetRequest, followPhoneCivet } from '../lib/nativeCivet.js';
export async function civetRequest(action,body,signal) {
  if(action==='source'&&isNativeSarah()) {
    selectCivetSource(body.source);
    if(body.source==='phone'){await followPhoneCivet();return nativeCivetRequest('status');}
    // Explicit handoff: release BLE before the server tries to acquire it.
    await nativeCivetRequest('disconnect');
  }
  if(usesNativeCivet()&&!action.startsWith('session/')) return nativeCivetRequest(action,body);
  const response=await fetch(apiUrl(`/civet/${action}`),body===undefined?{signal}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'CIVET request failed');return data;
}
export function useCivetLive(enabled=true) {
  const [state,setState]=useState({state:'disconnected',history:[],latest:null,acquisition:usesNativeCivet()?'phone':'server'});
  useEffect(()=>{if(enabled)civetRequest('resume',{}).catch(error=>setState(previous=>({...previous,error:error.message})));},[enabled]);
  useEffect(()=>{if(!enabled)return;let active=true,timer;const poll=async()=>{try{const data=await civetRequest('status');if(active)setState(data);}catch(error){if(active)setState(previous=>({...previous,latest:null,error:error.message,state:'unavailable'}));}finally{if(active)timer=setTimeout(poll,250);}};poll();return()=>{active=false;clearTimeout(timer);};},[enabled]);
  return enabled?state:{state:'not_in_use',history:[],latest:null};
}
export function useCivetTimeline(id,trim) {
  const [state,setState]=useState({id:null,rows:[],error:null});
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    if(!id)return;const controller=new AbortController();let active=true,timer;setState({id,rows:[],error:null,loading:true});
    const read=async()=>{try{const payload=await civetRequest(`session/${encodeURIComponent(id)}?encoding=columns`,undefined,controller.signal);if(active){const data=unpackCivetTimeline(payload);setState({id,rows:data.samples||[],analysis:data.analysis,sessionId:id,error:null,loading:false});if(data.analysis?.active)timer=setTimeout(read,5000);}}catch(error){if(active)setState(previous=>({...previous,id,loading:false,error:error.message}));}};
    read();return()=>{active=false;controller.abort();clearTimeout(timer);};
  },[id,revision]);
  const view=useMemo(()=>civetView({samples:state.rows,analysis:state.analysis},trim),[state.rows,state.analysis,trim]);
  const analysis = useMemo(() => view.analysis ? {...view.analysis, live: {...view.analysis.live, rows: view.samples}} : null, [view.analysis, view.samples]);
  return {...(state.id===id?{...state,rows:analysis?.reprocessed?.rows || view.samples,analysis}:{rows:[],error:null}),retry:()=>setRevision(n=>n+1)};
}
