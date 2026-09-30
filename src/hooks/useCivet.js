import {civetView} from '../lib/civetView.js';
import { useEffect, useState, useMemo } from 'react';
import { apiUrl } from '../lib/mobileApiBase.js';
export async function civetRequest(action,body) {
  const response=await fetch(apiUrl(`/civet/${action}`),body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'CIVET request failed');return data;
}
export function useCivetLive() {
  const [state,setState]=useState({state:'disconnected',history:[],latest:null});
  useEffect(()=>{let active=true,timer;const poll=async()=>{try{const data=await civetRequest('status');if(active)setState(data);}catch(error){if(active)setState(previous=>({...previous,latest:null,error:error.message,state:'unavailable'}));}finally{if(active)timer=setTimeout(poll,250);}};poll();return()=>{active=false;clearTimeout(timer);};},[]);
  return state;
}
export function useCivetTimeline(id,trim) {
  const [state,setState]=useState({id:null,rows:[],error:null});
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    if(!id)return;let active=true,timer;setState({id,rows:[],error:null});
    const read=async()=>{try{const data=await civetRequest(`session/${encodeURIComponent(id)}`);if(active){setState({id,rows:data.samples||[],analysis:data.analysis,sessionId:id,error:null});if(data.analysis?.active)timer=setTimeout(read,5000);}}catch(error){if(active)setState({id,rows:[],error:error.message});}};
    read();return()=>{active=false;clearTimeout(timer);};
  },[id,revision]);
  const view=useMemo(()=>civetView({samples:state.rows,analysis:state.analysis},trim),[state.rows,state.analysis,trim]);
  const analysis = useMemo(() => view.analysis ? {...view.analysis, live: {...view.analysis.live, rows: view.samples}} : null, [view.analysis, view.samples]);
  return {...(state.id===id?{...state,rows:analysis?.reprocessed?.rows || view.samples,analysis}:{rows:[],error:null}),retry:()=>setRevision(n=>n+1)};
}
