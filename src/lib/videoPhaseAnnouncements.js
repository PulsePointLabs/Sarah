import { phaseEvidenceAt } from './videoSyncPhaseEvidence.js';
export const VIDEO_PHASE_PHRASES = Object.freeze({build:['Sustained build.'],plateau:['Sustained plateau.'],approach:['Climax candidate.'],recovery:['Recovery.'],baseline:['Back near baseline.'],load:['Sustained physiological load.'],high_load:['High physiological load.']});
export const videoAnnouncementState=()=>({media:null,wall:null,candidate:'',since:0,wallSince:0,lastPhase:'',spokenAt:-Infinity});
export function playbackCandidate(point,exploration=false) {
  if(!point || ['warming','unavailable'].includes(point.phase))return '';
  if(point.phase==='recovery' && point.recovery>=60)return 'recovery';
  if(exploration){if(point.phase==='approach')return 'high_load';if(['build','plateau'].includes(point.phase))return 'load';return '';}
  if(point.phase==='approach' && point.approach>=75 && point.hrvUsable)return 'approach';
  if(point.phase==='plateau' && point.plateau>=65)return 'plateau';
  if(point.phase==='build' && point.delta>=8)return 'build';
  if(point.phase==='baseline')return 'baseline';
  return '';
}
export function stepVideoAnnouncement(previous,{points,time,wall,rate=1,active=true,seeking=false,exploration=false}) {
  let state={...previous};
  if(!active || seeking || !Number.isFinite(time))return {state:videoAnnouncementState(),cue:null,reset:true};
  const jump=state.media!=null && (time<state.media || time-state.media>Math.max(2,(wall-state.wall)/1000*rate+1));
  if(jump)state=videoAnnouncementState();
  const current=phaseEvidenceAt(points,time), phase=playbackCandidate(current,exploration);
  if(state.media==null){return {state:{...state,media:time,wall,candidate:phase,since:time,wallSince:wall},cue:null,reset:jump};}
  if(time===state.media)return {state:{...state,wall},cue:null};
  // Inspect every crossed telemetry point at high speed, without queuing old phases.
  let lo=0,hi=points.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(points[mid].t<=state.media)lo=mid+1;else hi=mid;}
  let prior=phaseEvidenceAt(points,state.media);
  for(let i=lo;i<points.length && points[i].t<=time;i++){
    const point=points[i],candidate=playbackCandidate(point,exploration);
    if(candidate!==state.candidate || !Number.isFinite(prior.t) || point.t-prior.t>5){state.candidate=candidate;state.since=point.t;state.wallSince=wall;}
    prior=point;
  }
  if(phase!==state.candidate){state.candidate=phase;state.since=time;state.wallSince=wall;}
  state.media=time;state.wall=wall;
  const ready=phase && time-state.since>=12 && wall-state.wallSince>=2500 && wall-state.spokenAt>=15000 && phase!==state.lastPhase && (phase!=='baseline'||state.lastPhase);
  return {state,cue:ready?{type:phase,phrase:VIDEO_PHASE_PHRASES[phase][0],atMs:wall}:null,reset:jump};
}
