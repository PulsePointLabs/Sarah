import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveCueAudio } from './useLiveCueAudio';
import { buildPhaseEvidence } from '../lib/videoSyncPhaseEvidence.js';
import { buildLoadEvidence } from '../lib/videoSyncLoadEvidence.js';
import { VIDEO_PHASE_PHRASES, stepVideoAnnouncement, videoAnnouncementState } from '../lib/videoPhaseAnnouncements.js';
import { loadTTSSettings } from '../components/TTSButton.jsx';
const KEY='sarah.videoSync.phaseVoice.v1';
export function useVideoPhaseAnnouncements({videoRef,active,sessionId,feedKey,offset,rows,civetRows,exploration,microphoneActive}) {
  const [settings,setSettings]=useState(()=>{try{const saved=JSON.parse(localStorage.getItem(KEY)||'{}');return {enabled:saved.enabled===true,volume:Math.max(0,Math.min(1,Number.isFinite(Number(saved.volume))?Number(saved.volume):.5))};}catch{return {enabled:false,volume:.5};}});
  const model=useMemo(()=>exploration?buildLoadEvidence(rows):buildPhaseEvidence(rows,civetRows),[rows,civetRows,exploration]);
  const voice=useMemo(()=>({...loadTTSSettings(),volume:settings.volume}),[settings.volume]);
  const audio=useLiveCueAudio({phrases:VIDEO_PHASE_PHRASES,settings:voice,enabled:settings.enabled&&active});
  const state=useRef(videoAnnouncementState()),inputs=useRef();const [message,setMessage]=useState('');
  inputs.current={audio,model,settings,active,offset,exploration,microphoneActive};
  useEffect(()=>{try{localStorage.setItem(KEY,JSON.stringify(settings));}catch{}},[settings]);
  useEffect(()=>{state.current=videoAnnouncementState();audio.stop();setMessage('');},[sessionId,feedKey,offset,active,settings.enabled,audio.stop]);
  useEffect(()=>{if(settings.enabled&&active&&audio.status.phase==='idle')audio.prepare().catch(()=>{});},[settings.enabled,active,audio.status.phase,audio.prepare]);
  useEffect(()=>{
    const video=videoRef.current;
    const reset=()=>{state.current=videoAnnouncementState();inputs.current.audio.stop();};
    for(const name of ['seeking','pause','ended','waiting','ratechange'])video?.addEventListener(name,reset);
    const timer=setInterval(()=>{
      const input=inputs.current,v=videoRef.current;if(!v)return;
      const result=stepVideoAnnouncement(state.current,{points:input.model.points,time:v.currentTime+(Number(input.offset)||0),wall:Date.now(),rate:v.playbackRate,active:input.active&&input.settings.enabled&&!v.paused&&!v.ended&&v.readyState>=3&&!input.microphoneActive,seeking:v.seeking,exploration:input.exploration});
      state.current=result.state;if(result.reset)input.audio.stop();
      if(result.cue){const played=input.audio.playCue(result.cue);if(played.ok){state.current={...result.state,lastPhase:result.cue.type,spokenAt:result.cue.atMs};setMessage(`Last: ${result.cue.phrase}`);}}
    },250);
    return()=>{clearInterval(timer);for(const name of ['seeking','pause','ended','waiting','ratechange'])video?.removeEventListener(name,reset);reset();};
  },[active,feedKey,videoRef]);
  const toggle=()=>{if(!settings.enabled)audio.unlock().catch(e=>setMessage(e.message));else audio.stop();setSettings(s=>({...s,enabled:!s.enabled}));};
  const test=async()=>{try{const result=await audio.testVoice();setMessage(result.ok?'Voice ready.':`Audio not ready: ${result.reason}`);}catch(e){setMessage(e.message);}};
  return {settings,setSettings,audio,message,toggle,test};
}

