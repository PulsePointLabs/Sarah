import { useEffect, useState } from 'react';
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
export function useCivetTimeline(id) {
  const [state,setState]=useState({id:null,rows:[],error:null});
  const [revision,setRevision]=useState(0);
  useEffect(()=>{if(!id)return;let active=true;setState({id,rows:[],error:null});civetRequest(`session/${encodeURIComponent(id)}`).then(data=>{if(active)setState({id,rows:data.samples||[],error:null});}).catch(error=>{if(active)setState({id,rows:[],error:error.message});});return()=>{active=false;};},[id,revision]);
  return {...(state.id===id?state:{rows:[],error:null}),retry:()=>setRevision(n=>n+1)};
}
