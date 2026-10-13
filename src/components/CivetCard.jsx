import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { contractionSnapshot } from '../lib/civetSnapshot.js';
import { civetAt } from '../lib/civet.js';
import { linkIntervals, summarizeTrains } from '../lib/civetAnalysis.js';
import { useCivetTimeline } from '../hooks/useCivet.js';
import { apiUrl } from '../lib/mobileApiBase.js';
import { civetTraceBreak } from '../lib/civetTiming.js';
import './civet.css';
import CivetPressureReview from './CivetPressureReview.jsx';
import { videoPressureSummary } from '../lib/videoPressureView.js';
import { civetLiveColor } from '../lib/civetLiveColor.js';
const fmt=(v,d=2)=>v==null?'—':Number(v).toFixed(d);
const colors={raw:'#a6b1bd',filtered:'#fff',tonic:'#fbbf24',phasic:'#2dd4bf'};
const fields={raw:'pressure_kpa',filtered:'filtered_kpa',tonic:'tonic_kpa',phasic:'phasic_kpa'};
export function CivetPlot({rows,events=[],start,end,layers,onSeek,markers=[],playheadS,localScale=false,domain,accent}) {
  const plotRef=useRef(null),[size,setSize]=useState({width:600,height:166});
  useLayoutEffect(()=>{const element=plotRef.current;const measure=()=>{const bounds=element.getBoundingClientRect();if(bounds.width>0&&bounds.height>0)setSize(previous=>Math.abs(previous.width-bounds.width)<.5&&Math.abs(previous.height-bounds.height)<.5?previous:{width:bounds.width,height:bounds.height});};const observer=new element.ownerDocument.defaultView.ResizeObserver(measure);observer.observe(element);measure();return()=>observer.disconnect();},[]);
  const {width,height}=size,left=34,right=Math.max(44,width-8),top=height<50?2:12,bottom=Math.max(top+8,height-(height<50?20:34)),durationY=height-(height<50?5:12);
  const points=rows.filter(p=>p.t>=start&&p.t<=end),selected=Object.keys(fields).filter(k=>layers[k]);
  const values=points.flatMap(p=>selected.map(k=>p[fields[k]]??(k==='filtered'?p.pressure_kpa:null)).filter(Number.isFinite));
  const min=domain?.[0]??(localScale&&values.length?Math.min(...values)-.05:Math.min(0,...values)),max=domain?.[1]??Math.max(min+.1,...values),x=t=>left+(t-start)/Math.max(.1,end-start)*(right-left),y=v=>bottom-(v-min)/(max-min)*(bottom-top);
  const visible=events.filter(e=>e.end>=start&&e.onset<=end&&(e.mode==='review'||e.confirmed_at<=end));
  const timeLabel=t=>`${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}`;
  return <svg ref={plotRef} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Pelvic pressure in kPa over time; shaded contractions with duration bars and marked peaks" onClick={onSeek?e=>{const r=e.currentTarget.getBoundingClientRect();const t=(e.clientX-r.left)/r.width*width;onSeek(Math.max(start,Math.min(end,start+(t-left)/(right-left)*(end-start))));}:undefined}>
    {(height<85?[0,1]:[0,.5,1]).map(f=>{const value=min+(max-min)*f;return <g key={f}><line x1={left} x2={right} y1={y(value)} y2={y(value)} stroke="#ffffff" opacity=".12"/>{height>=50&&<text x={left-5} y={y(value)+3} textAnchor="end" fill="#cbd5e1" fontSize="10">{fmt(value,1)}</text>}</g>;})}
    <text x="4" y="10" fill="#cbd5e1" fontSize="10">kPa</text>
    {layers.events&&visible.map(e=>{const onset=Math.max(left,x(e.onset)),offset=Math.min(right,x(e.end)),color=e.quality==='usable'?'#2dd4bf':'#fbbf24';return <g key={e.id}>
      <rect x={onset} width={Math.max(1,offset-onset)} y={top} height={bottom-top} fill={color} opacity=".12"/>
      <rect x={onset} width={Math.max(1,offset-onset)} y={durationY} height="6" rx="2" fill={color} opacity=".8"><title>{`Contraction ${e.event_index} · ${fmt(e.duration_s??e.end-e.onset,2)}s · onset ${fmt(e.onset,1)}s → end ${fmt(e.end,1)}s`}</title></rect>
      {offset-onset>32&&height>100&&<text x={(onset+offset)/2} y={height-1} textAnchor="middle" fill={color} fontSize="9">{fmt(e.duration_s??e.end-e.onset,1)}s</text>}
    </g>;})}
    {selected.map(k=>{let previous=null;const trace=points.map(p=>{const v=p[fields[k]]??(k==='filtered'?p.pressure_kpa:null);if(!Number.isFinite(v)){previous=null;return '';}const move=civetTraceBreak(previous,p);previous=p;return `${move?'M':'L'}${x(p.t)},${y(v)}`;}).join(' ');return <path key={k} d={trace} fill="none" stroke={k==='filtered'&&accent?accent:colors[k]} strokeWidth={k==='raw'?1:2} vectorEffect="non-scaling-stroke"/>;})}
    {layers.events&&visible.filter(e=>e.peak>=start&&e.peak<=end).map(e=><g key={`peak-${e.id}`}>
      <line x1={x(e.peak)} x2={x(e.peak)} y1={top} y2={bottom} stroke={e.quality==='usable'?'#2dd4bf':'#fbbf24'} strokeDasharray="2 3" opacity=".6"/>
      <circle role="button" tabIndex={0} aria-label={`Contraction ${e.event_index} at ${fmt(e.peak,1)} seconds, duration ${fmt(e.duration_s??e.end-e.onset,2)} seconds`} cx={x(e.peak)} cy={selected.includes('filtered')?y(e.peak_pressure_kpa):selected.includes('raw')?y(e.raw_peak_pressure_kpa??e.peak_pressure_kpa):selected.includes('phasic')?y(e.peak_pressure_kpa-e.tonic_kpa):selected.includes('tonic')?y(e.tonic_kpa):18} r="3.5" fill={e.quality==='usable'?'#2dd4bf':'#fbbf24'} onClick={ev=>{ev.stopPropagation();onSeek?.(e.peak);}} onKeyDown={ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();onSeek?.(e.peak);}}}><title>{`Peak ${fmt(e.peak,1)}s · duration ${fmt(e.duration_s??e.end-e.onset,2)}s · spacing ${fmt(e.preceding_interval_s,2)}s · prominence ${fmt(e.prominence_kpa)} kPa · ${(e.flags||[]).join(', ')||'usable'}`}</title></circle>
    </g>)}
    {(width<300?[0,.5,1]:[0,.25,.5,.75,1]).map(f=><text key={f} x={left+(right-left)*f} y={bottom+(height<50?9:13)} textAnchor={f===0?'start':f===1?'end':'middle'} fill="#cbd5e1" fontSize="10">{timeLabel(start+(end-start)*f)}</text>)}
    <text x="0" y={durationY+5} fill="#cbd5e1" fontSize="8">Dur.</text>
    {Number.isFinite(playheadS)&&playheadS>=start&&playheadS<=end&&<line x1={x(playheadS)} x2={x(playheadS)} y1={top} y2={bottom} stroke="#f8fafc" strokeWidth="1.5" vectorEffect="non-scaling-stroke"/>}
    {markers.filter(m=>Number.isFinite(m.t)&&m.t>=start&&m.t<=end).map((m,i)=><g key={i}><line x1={x(m.t)} x2={x(m.t)} y1={top} y2={bottom} stroke="#e879f9" strokeWidth="2"/><title>{m.label} · {fmt(m.t,1)}s</title></g>)}
  </svg>;
}
function Exports({sessionId,mode}) {
  if(!sessionId)return null;
  return <div className="civet-export">{['samples','events','trains','analysis'].map(kind=><a key={kind} href={apiUrl(`/civet/session/${encodeURIComponent(sessionId)}/export?kind=${kind}&mode=${mode}`)}>Export {kind}{kind==='analysis'?' JSON':' CSV'}</a>)}</div>;
}
export default function CivetCard({rows=[],sample,playheadS,onSeek,onPlay,compact=false,statusText,analysis,sessionId,markers=[],windowSeconds=30}) {
  const [open,setOpen]=useState(false),[portalRoot,setPortalRoot]=useState(null),[mode,setMode]=useState('reprocessed'),[layers,setLayers]=useState({raw:false,filtered:true,tonic:true,phasic:false,events:true}),[selectedTrain,setSelectedTrain]=useState(null);
  const [view,setView]=useState(()=>{try{return ['balanced','waveform','burst'].includes(localStorage.getItem('sarah.video.pressure.view'))?localStorage.getItem('sarah.video.pressure.view'):'balanced';}catch{return 'balanced';}});
  useEffect(()=>{if(!open)return;const doc=portalRoot?.ownerDocument||document;const close=e=>{if(e.key==='Escape')setOpen(false);};doc.addEventListener('keydown',close);return()=>doc.removeEventListener('keydown',close);},[open,portalRoot]);
  const review=mode==='review'&&analysis?.review;
  const reprocessed=mode==='reprocessed'&&analysis?.reprocessed;
  const selectedAnalysis=review || reprocessed || analysis?.live;
  const displayRows=selectedAnalysis?.rows || rows;
  const events=useMemo(()=>selectedAnalysis?.events||linkIntervals(displayRows.flatMap(r=>r.events||[])),[selectedAnalysis,displayRows]);
  const trains=useMemo(()=>selectedAnalysis?.trains||summarizeTrains(events,displayRows),[selectedAnalysis,events,displayRows]);
  const current=sample===undefined?civetAt(displayRows,playheadS):sample;
  const end=playheadS??current?.t??displayRows.at(-1)?.t??0,start=Math.max(displayRows[0]?.t??0,end-windowSeconds);
  const snapshot=contractionSnapshot(events,end,start);
  const rolling=displayRows.filter(row=>row.t>=end-30&&row.t<=end&&!row.gap&&Number.isFinite(row.pressure_kpa));
  const average=rolling.length?rolling.reduce((sum,row)=>sum+row.pressure_kpa,0)/rolling.length:null;
  const peak=rolling.length?Math.max(...rolling.map(row=>row.pressure_kpa)):null;
  const level=current?.usable?Math.min(100,current.level_pct):null,hue=level==null?200:170-level*1.5;
  const pulseCount=review?events.filter(e=>e.peak<=end&&e.peak>=end-60&&e.quality==='usable').length:current?.contractions_60s;
  const displayState=review?`Review · ${current?.calibration_valid?'calibration valid':'normalization withheld'}`:current?.evidence;
  const train=trains.find(t=>t.train_index===selectedTrain);
  const viewStart=train?Math.max(displayRows[0]?.t??0,train.start-2):start,viewEnd=train?Math.min(displayRows.at(-1)?.t??end,train.end+2):end;
  const seek=t=>onSeek?.(t);
  const summary=useMemo(()=>videoPressureSummary(displayRows,events,end),[displayRows,events,end]);
  const cardRows=useMemo(()=>summary.relative?displayRows.map(row=>({...row,pressure_kpa:(row.usable??row.calibration_valid)&&row.calibration?.id===summary.current?.calibration?.id?row.delta_kpa:null,filtered_kpa:(row.usable??row.calibration_valid)&&row.calibration?.id===summary.current?.calibration?.id?row.delta_kpa:null,tonic_kpa:row.tonic_kpa-(row.calibration?.baseline??0)})):displayRows,[displayRows,summary.relative,summary.current?.calibration?.id]);
  const cardEvents=useMemo(()=>summary.relative?events.filter(event=>event.calibration?.id===summary.current?.calibration?.id).map(event=>({...event,peak_pressure_kpa:event.peak_pressure_kpa-(event.calibration?.baseline??0),raw_peak_pressure_kpa:(event.raw_peak_pressure_kpa??event.peak_pressure_kpa)-(event.calibration?.baseline??0),tonic_kpa:event.tonic_kpa-(event.calibration?.baseline??0)})):events,[events,summary.relative,summary.current?.calibration?.id]);
  const visual=civetLiveColor({current:summary.relative?summary.value:null,sample:current,held:summary.held,rhythmic:summary.snapshot.train.length>=3});
  const recentBurst=summary.snapshot.train;
  const cardStart=view==='burst'&&recentBurst.length?Math.max(displayRows[0]?.t??0,recentBurst[0].onset-1,end-12):start;
  const changeView=value=>{setView(value);try{localStorage.setItem('sarah.video.pressure.view',value);}catch{}};

  return <section className={`civet-card pressure-video-card pressure-video-${view} ${compact?'civet-compact':''} ${current?'civet-has-sample':''}`} aria-label="CIVET pelvic pressure" style={{background:visual.background,borderColor:visual.accent,'--pressure-accent':visual.accent}}>
    <header><b>Pelvic pressure</b><div className="pressure-video-actions"><select aria-label="Pressure card view" value={view} onChange={e=>changeView(e.target.value)}><option value="balanced">Balanced</option><option value="waveform">Waveform first</option><option value="burst">Burst review</option></select><button className="civet-review-button" onClick={e=>{setPortalRoot(e.currentTarget.ownerDocument.body);setOpen(true);}}>Inspect</button></div></header>
    <div className="pressure-video-values">{view==='burst'?<><div><strong>{summary.snapshot.train.length||'—'}<small> peaks</small></strong><span>Resolved · 10s</span></div><div><strong>{fmt(recentBurst.length?recentBurst.at(-1).end-recentBurst[0].onset:null,1)}<small> s</small></strong><span>Recent burst</span></div><div><strong>{fmt(summary.snapshot.spacing,2)}<small> s</small></strong><span>Typical spacing</span></div></>:<><div><strong>{fmt(summary.value,1)}<small> kPa</small></strong><span>{summary.relative?'Above rest':'Measured pressure'}</span></div>{view!=='waveform'&&<><div><strong>{fmt(summary.average,1)}</strong><span>Average · 30s</span></div><div><strong>{fmt(summary.peak,1)}</strong><span>Max · 30s</span></div></>}</>}</div>
    {!current&&<div className="civet-state">{statusText||'No current pressure sample'}</div>}
    <div className="civet-rhythm" aria-label="Rolling contraction snapshot"><span>{summary.held?'Current hold':'Last pulse'} <b>{fmt(summary.duration,2)}s</b></span><span>Spacing <b>{fmt(summary.snapshot.spacing,2)}s</b></span><span>Repeated <b>{summary.snapshot.train.length||'—'} / 10s</b></span></div>
    <CivetPlot rows={cardRows} events={cardEvents} start={cardStart} end={Math.max(end,cardStart+.1)} layers={{filtered:true,events:true}} domain={summary.range} accent={visual.accent} onSeek={onSeek} markers={markers} playheadS={end}/>
    <footer><span>{Math.round(end-cardStart)}s · {summary.relative?'above recorded rest':'measured kPa'}</span><span>{view==='burst'?'Latest resolved burst':summary.relative?'Reference ready':'Reference uncertain'}</span></footer>
    {open&&createPortal(<div className="civet-inspector-backdrop"><section role="dialog" aria-modal="true" aria-label="CIVET contraction analysis" className="civet-inspector" onKeyDown={e=>{if(e.key==='Escape')setOpen(false);}}>
      <header><h2>Pelvic pressure · Review</h2><button autoFocus onClick={()=>setOpen(false)}>Close</button></header>
      <div className="civet-tools"><label>Analysis <select aria-label="Analysis version" value={review?'review':reprocessed?'reprocessed':'live'} onChange={e=>{setMode(e.target.value);setSelectedTrain(null);}}>{analysis?.reprocessed&&<option value="reprocessed">Reprocessed pressure (corrected policy)</option>}<option value="live">Recorded live (causal)</option>{analysis?.review&&<option value="review">Retrospective review (noncausal)</option>}</select></label></div>
      <CivetPressureReview rows={displayRows} events={events} trains={trains} train={train} playhead={end} start={viewStart} end={viewEnd} onSelect={setSelectedTrain} onSeek={seek} onPlay={onPlay} markers={markers} Plot={CivetPlot} />
      <details className="pressure-review-advanced"><summary>Signal &amp; analysis details</summary>
      <p>Mechanical pressure, not calibrated muscle force. A contraction train is supporting evidence, not proof of orgasm. Amber events need review; their possible causes cannot be distinguished from pressure alone.</p>
      <p>100% means the pressure rise above rest matches your comfortable calibration hold. Higher values can occur; this is not maximum strength or percent toward climax. Rest: {fmt(current?.calibration?.baseline)} kPa · calibration hold rise: {fmt(current?.calibration?.reference)} kPa. Zeroing the hardware is separate from measuring this resting baseline.</p>
      <p>At playhead: {fmt(current?.pressure_kpa)} kPa · 30s average {fmt(average)} · 30s peak {fmt(peak)} · 60s pulses {pulseCount??'—'} · tonic {fmt(current?.tonic_kpa)} kPa.</p>
<p>Technical plot layers</p><div className="civet-tools">{Object.keys(layers).map(k=><label key={k}><input type="checkbox" checked={layers[k]} onChange={e=>setLayers(p=>({...p,[k]:e.target.checked}))}/>{k}</label>)}</div>
      {reprocessed && <p>Reprocessed from unchanged raw samples. {reprocessed.recovered_samples} samples regained reference metrics under {reprocessed.policy}. The original rest/hold calibration is retained; disconnects and genuine calibration failures remain flagged. This is pressure relative to that reference, not absolute muscle force.</p>}
      <p>{review?'Symmetric pressure smoothing and centered tonic estimate. Does not change the recorded live phase model.':'Peaks are confirmed after a falling shoulder and trough. Confirmation timestamps remain distinct from observed peaks.'} Timing is sample-based (~0.1s); no interpolated samples.</p>
      <div className="civet-inspector-plot"><CivetPlot rows={displayRows} events={events} start={viewStart} end={viewEnd} layers={layers} onSeek={onSeek} markers={markers} playheadS={end}/></div>
      <p>{fmt(viewStart,1)}–{fmt(viewEnd,1)}s · kPa. {current?.calibration_valid?'Calibration valid':'Calibration missing or invalid'} · {current?.quality_flags?.join(', ')||'No current quality flags'}</p>
      <div className="civet-tools"><button onClick={()=>setSelectedTrain(null)}>Follow playhead</button>{trains.map(t=><button key={t.train_index} onClick={()=>{setSelectedTrain(t.train_index);seek(t.first_contraction_s);}}>Train {t.train_index} · {fmt(t.first_contraction_s,1)}s · {t.count} peaks{t.flags.length?' ⚠':''}</button>)}</div>
      {!trains.length&&<p>No train of at least three resolved contractions detected.</p>}
      {train&&<div className="civet-train-summary"><p>{train.count} contractions · {fmt(train.duration_s,1)}s · interval mean / median {fmt(train.mean_interval_s,1)} / {fmt(train.median_interval_s,1)}s · interval CV {fmt(train.interval_cv)} · amplitude mean / median / max {fmt(train.mean_amplitude_kpa)} / {fmt(train.median_amplitude_kpa)} / {fmt(train.max_amplitude_kpa)} kPa · amplitude trend {fmt(train.amplitude_slope_kpa_s)} kPa/s</p><p>Tonic before / during / after {fmt(train.tonic_before_kpa)} / {fmt(train.tonic_during_kpa)} / {fmt(train.tonic_after_kpa)} kPa · {train.flags.join(', ')||'No flagged events'}</p>{markers.filter(m=>Number.isFinite(m.t)).map((m,i)=><p key={i}>{m.label}: first peak {fmt(train.first_contraction_s-m.t,1)}s relative to marker</p>)}<details><summary>All train metrics</summary><pre>{JSON.stringify(train,null,2)}</pre></details></div>}
      <p>Events below cover the recording. The chart follows the playhead unless a complete train is selected.</p><div className="civet-event-list"><table><thead><tr><th>Peak (s)</th><th>Amplitude</th><th>Prominence</th><th>Rise / fall (s)</th><th>Quality / details</th></tr></thead><tbody>{events.filter(e=>!train||train.event_ids.includes(e.id)).map(e=><tr key={e.id}><td><button onClick={()=>seek(e.peak)}>{fmt(e.peak,1)}</button></td><td>{fmt(e.amplitude_kpa)}</td><td>{fmt(e.prominence_kpa)}</td><td>{fmt(e.rise_s,1)} / {fmt(e.fall_s,1)}</td><td><details><summary>{e.flags.join(', ')||'usable'}</summary><pre>{JSON.stringify(e,null,2)}</pre></details></td></tr>)}</tbody></table></div>
      {!events.length&&<p>No resolved contraction events in this data. Legacy recordings retain their original live features; choose retrospective review for morphology.</p>}
      <details><summary>Calibration and acquisition history</summary><pre>{JSON.stringify({current_calibration:current?.calibration||null,metadata:analysis?.metadata||[],algorithm:review?.algorithm||current?.algorithm},null,2)}</pre></details>
      {analysis?.view_offset_s>0&&<p>Display times subtract {fmt(analysis.view_offset_s,1)}s from the original session. Exports retain the original session clock.</p>}
      <Exports sessionId={sessionId} mode={review?'review':reprocessed?'reprocessed':'live'}/>
      </details>
    </section></div>,portalRoot||document.body)}
  </section>;
}
export function CivetSession({sessionId,markers=[],trim}) {
  const {rows,analysis,error,retry}=useCivetTimeline(sessionId,trim);const [time,setTime]=useState(null);
  if(error)return <div className="text-sm">CIVET history unavailable: {error} <button onClick={retry}>Retry</button></div>;
  if(!rows.length)return null;
  const at=time??rows.at(-1).t;
  return <details id="session-civet" className="rounded-xl border border-border p-2" open><summary className="cursor-pointer font-bold text-primary">CIVET · Pelvic pressure</summary>
    <div style={{height:300}}><CivetCard rows={rows} analysis={analysis} sessionId={sessionId} playheadS={at} onSeek={setTime} markers={markers}/></div>
    <input aria-label="CIVET session time" type="range" min={rows[0].t} max={rows.at(-1).t} step="0.1" value={at} onChange={e=>setTime(Number(e.target.value))} className="w-full"/>
    <Exports sessionId={sessionId} mode={analysis?.reprocessed?'reprocessed':analysis?.review?'review':'live'}/>
  </details>;
}
