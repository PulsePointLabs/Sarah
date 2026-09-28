import {useEffect,useMemo,useRef,useState} from 'react';
import {useLiveCueAudio} from '../hooks/useLiveCueAudio';
import {loadTTSSettings} from './TTSButton';
import './civetLive.css';
const phrase='CIVET needs attention. Please check the pressure sensor display.';
const phrases={sensor:[phrase]};
export default function CivetLiveAlert({live,onSetup}) {
  const [muted,setMuted]=useState(false),[ack,setAck]=useState(false);
  const voice=useMemo(()=>({...loadTTSSettings(),volume:.75}),[]);
  const active=!!live.history?.length;
  const state=live.latest?.acquisition_state;
  const problem=active&&(!live.latest||['recalibrate','checking','recovering'].includes(state));
  const audio=useLiveCueAudio({phrases,settings:voice,enabled:active&&!muted});
  const announced=useRef(false),since=useRef(null);
  useEffect(()=>{if(active&&!muted&&audio.status.phase==='idle')audio.prepare().catch(()=>{});},[active,muted,audio.status.phase,audio.prepare]);
  useEffect(()=>{const unlock=()=>audio.unlock().catch(()=>{});if(active)window.addEventListener('pointerdown',unlock);return()=>window.removeEventListener('pointerdown',unlock);},[active,audio.unlock]);
  useEffect(()=>{
    if(!problem){announced.current=false;since.current=null;setAck(false);return;}
    since.current??=Date.now();
    const attempt=()=>{if(!muted&&!announced.current&&Date.now()-since.current>=3000){const result=audio.playCue({type:'sensor',phrase,atMs:Date.now()});if(result.ok)announced.current=true;}};
    const timer=setInterval(attempt,500);attempt();return()=>clearInterval(timer);
  },[problem,muted,audio]);
  if(!problem)return null;
  return <aside className="civet-live-alert" role="alert"><p><b>CIVET: {live.latest?.acquisition_message||'No fresh pressure signal. Check Bluetooth and sensor.'}</b></p>{!ack&&<><small>Raw samples are saved when received. Relative intensity and hold duration may be unavailable.</small><small>{muted?'Spoken alert muted':!audio.ready?'Spoken alert not ready — use Enable / test sound':'Spoken alert enabled'}</small></>}
    <div className="civet-live-alert-controls"><button onClick={onSetup}>Check / recalibrate</button><button onClick={()=>{setMuted(false);audio.testVoice().catch(()=>{});}}>Enable / test sound</button><button onClick={()=>{setMuted(v=>!v);audio.stop();}}>{muted?'Unmute':'Mute alert'}</button>{!ack&&<button onClick={()=>setAck(true)}>Understood</button>}</div></aside>;
}
