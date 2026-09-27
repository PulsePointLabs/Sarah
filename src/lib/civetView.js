import {summarizeTrains} from './civetAnalysis.js';
// Display-only rebasing. Exports and persisted timestamps stay in the original clock.
export function civetView(data,trim) {
  if(!trim||!Number.isFinite(trim.start_s)||!Number.isFinite(trim.end_s))return data;
  const start=trim.start_s,end=trim.end_s;
  const event=e=>({...e,source_peak:e.peak,...Object.fromEntries(['onset','peak','end','trough','confirmed_at'].map(k=>[k,Number.isFinite(e[k])?e[k]-start:null]))});
  const events=a=>(a||[]).filter(e=>e.peak>=start&&e.peak<=end).map(event);
  const rows=a=>(a||[]).filter(r=>r.t>=start&&r.t<=end).map(r=>({...r,source_t:r.t,t:r.t-start,events:events(r.events)}));
  const samples=rows(data.samples),analysis=data.analysis?{...data.analysis,view_offset_s:start}:null;
  if(analysis)for(const mode of ['live','review']) {
    if(!analysis[mode])continue;
    const displayRows=mode==='live'?samples:rows(analysis[mode].rows),displayEvents=events(analysis[mode].events);
    analysis[mode]={...analysis[mode],...(mode==='review'?{rows:displayRows}:{}),events:displayEvents,trains:summarizeTrains(displayEvents,displayRows)};
  }
  return {...data,samples,analysis};
}
