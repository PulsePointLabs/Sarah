import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { contractionSnapshot } from '../lib/civetSnapshot.js';
import { civetAt } from '../lib/civet.js';
import { linkIntervals, summarizeTrains } from '../lib/civetAnalysis.js';
import { useCivetTimeline } from '../hooks/useCivet.js';
import { apiUrl } from '../lib/mobileApiBase.js';
import { civetTraceBreak } from '../lib/civetTiming.js';
import './civet.css';
const fmt=(v,d=2)=>v==null?'—':Number(v).toFixed(d);
const colors={raw:'#a6b1bd',filtered:'#fff',tonic:'#fbbf24',phasic:'#2dd4bf'};
const fields={raw:'pressure_kpa',filtered:'filtered_kpa',tonic:'tonic_kpa',phasic:'phasic_kpa'};
export function CivetPlot({rows,events=[],start,end,layers,onSeek,markers=[],playheadS}) {
  const points=rows.filter(p=>p.t>=start&&p.t<=end),selected=Object.keys(fields).filter(k=>layers[k]);
  const values=points.flatMap(p=>selected.map(k=>p[fields[k]]??(k==='filtered'?p.pressure_kpa:null)).filter(Number.isFinite));
  const min=Math.min(0,...values),max=Math.max(.1,...values),x=t=>46+(t-start)/Math.max(.1,end-start)*544,y=v=>112-(v-min)/(max-min)*94;
  const visible=events.filter(e=>e.end>=start&&e.onset<=end&&(e.mode==='review'||e.confirmed_at<=end));
  const timeLabel=t=>`${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}`;
  return <svg viewBox="0 0 600 166" preserveAspectRatio="none" role="img" aria-label="Pelvic pressure in kPa over time; shaded contractions with duration bars and marked peaks" onClick={onSeek?e=>{const r=e.currentTarget.getBoundingClientRect();const t=(e.clientX-r.left)/r.width*600;onSeek(Math.max(start,Math.min(end,start+(t-46)/544*(end-start))));}:undefined}>
    {[0,.5,1].map(f=>{const value=min+(max-min)*f;return <g key={f}><line x1="46" x2="590" y1={y(value)} y2={y(value)} stroke="#ffffff" opacity=".12"/><text x="40" y={y(value)+3} textAnchor="end" fill="#cbd5e1" fontSize="10">{fmt(value,1)}</text></g>;})}
    <text x="4" y="10" fill="#cbd5e1" fontSize="10">kPa</text>
    {layers.events&&visible.map(e=>{const left=Math.max(46,x(e.onset)),right=Math.min(590,x(e.end)),color=e.quality==='usable'?'#2dd4bf':'#fbbf24';return <g key={e.id}>
      <rect x={left} width={Math.max(1,right-left)} y="18" height="94" fill={color} opacity=".12"/>
      <rect x={left} width={Math.max(1,right-left)} y="140" height="8" rx="2" fill={color} opacity=".8"><title>{`Contraction ${e.event_index} · ${fmt(e.duration_s??e.end-e.onset,2)}s · onset ${fmt(e.onset,1)}s → end ${fmt(e.end,1)}s`}</title></rect>
      {right-left>32&&<text x={(left+right)/2} y="160" textAnchor="middle" fill={color} fontSize="9">{fmt(e.duration_s??e.end-e.onset,1)}s</text>}
    </g>;})}
    {selected.map(k=>{let previous=null;const trace=points.map(p=>{const v=p[fields[k]]??(k==='filtered'?p.pressure_kpa:null);if(!Number.isFinite(v)){previous=null;return '';}const move=civetTraceBreak(previous,p);previous=p;return `${move?'M':'L'}${x(p.t)},${y(v)}`;}).join(' ');return <path key={k} d={trace} fill="none" stroke={colors[k]} strokeWidth={k==='raw'?1:2} vectorEffect="non-scaling-stroke"/>;})}
    {layers.events&&visible.filter(e=>e.peak>=start&&e.peak<=end).map(e=><g key={`peak-${e.id}`}>
      <line x1={x(e.peak)} x2={x(e.peak)} y1="18" y2="112" stroke={e.quality==='usable'?'#2dd4bf':'#fbbf24'} strokeDasharray="2 3" opacity=".6"/>
      <circle role="button" tabIndex={0} aria-label={`Contraction ${e.event_index} at ${fmt(e.peak,1)} seconds, duration ${fmt(e.duration_s??e.end-e.onset,2)} seconds`} cx={x(e.peak)} cy={selected.includes('filtered')?y(e.peak_pressure_kpa):selected.includes('raw')?y(e.raw_peak_pressure_kpa??e.peak_pressure_kpa):selected.includes('phasic')?y(e.peak_pressure_kpa-e.tonic_kpa):selected.includes('tonic')?y(e.tonic_kpa):18} r="3.5" fill={e.quality==='usable'?'#2dd4bf':'#fbbf24'} onClick={ev=>{ev.stopPropagation();onSeek?.(e.peak);}} onKeyDown={ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();onSeek?.(e.peak);}}}><title>{`Peak ${fmt(e.peak,1)}s · duration ${fmt(e.duration_s??e.end-e.onset,2)}s · spacing ${fmt(e.preceding_interval_s,2)}s · prominence ${fmt(e.prominence_kpa)} kPa · ${(e.flags||[]).join(', ')||'usable'}`}</title></circle>
    </g>)}
    {[0,.25,.5,.75,1].map(f=><text key={f} x={46+544*f} y="130" textAnchor={f===0?'start':f===1?'end':'middle'} fill="#cbd5e1" fontSize="10">{timeLabel(start+(end-start)*f)}</text>)}
    <text x="4" y="147" fill="#cbd5e1" fontSize="9">Duration</text>
    {Number.isFinite(playheadS)&&playheadS>=start&&playheadS<=end&&<line x1={x(playheadS)} x2={x(playheadS)} y1="12" y2="116" stroke="#f8fafc" strokeWidth="1.5" vectorEffect="non-scaling-stroke"/>}
    {markers.filter(m=>Number.isFinite(m.t)&&m.t>=start&&m.t<=end).map((m,i)=><g key={i}><line x1={x(m.t)} x2={x(m.t)} y1="12" y2="116" stroke="#e879f9" strokeWidth="2"/><title>{m.label} · {fmt(m.t,1)}s</title></g>)}
  </svg>;
}
function Exports({sessionId,mode}) {
  if(!sessionId)return null;
  return <div className="civet-export">{['samples','events','trains','analysis'].map(kind=><a key={kind} href={apiUrl(`/civet/session/${encodeURIComponent(sessionId)}/export?kind=${kind}&mode=${mode}`)}>Export {kind}{kind==='analysis'?' JSON':' CSV'}</a>)}</div>;
}
export default function CivetCard({rows=[],sample,playheadS,onSeek,compact=false,statusText,analysis,sessionId,markers=[],windowSeconds=30}) {
  const [open,setOpen]=useState(false),[portalRoot,setPortalRoot]=useState(null),[mode,setMode]=useState('reprocessed'),[layers,setLayers]=useState({raw:false,filtered:true,tonic:true,phasic:false,events:true}),[selectedTrain,setSelectedTrain]=useState(null);
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
  return <section className={`civet-card ${compact?'civet-compact':''}`} aria-label="CIVET pelvic pressure" style={{background:`hsl(${hue} 55% ${level==null?11:14+level*.07}% / .95)`,borderColor:`hsl(${hue} 65% 48%)`}}>
    <header><b>CIVET · PELVIC RESPONSE</b><button className="civet-review-button" onClick={e=>{setPortalRoot(e.currentTarget.ownerDocument.body);setOpen(true);}}>Inspect</button></header>
    <div className="civet-main"><strong>{fmt(current?.delta_kpa??current?.pressure_kpa)}<small> kPa{current?.delta_kpa!=null?' above rest':''}</small></strong><b title="Pressure above your recorded rest divided by the rise during your calibration hold. 100% matches that hold; it is not maximum strength or an arousal score.">{fmt(current?.usable?current.level_pct:null,0)}<small>% of calibration hold</small></b></div>
    <div className="civet-state" title={statusText||current?.evidence}>{statusText||displayState||'No current pressure sample'}{current?.calibration_remaining_s>0?` · ${Math.ceil(current.calibration_remaining_s)}s`:''}</div>
    <div className="civet-stats"><span>30s avg <b>{fmt(average)}</b></span><span>30s peak <b>{fmt(peak)}</b></span><span>60s pulses <b>{pulseCount??'—'}</b></span><span>Tonic <b>{fmt(current?.tonic_kpa)}</b></span></div>
    <div className="civet-rhythm" aria-label="Rolling contraction snapshot">
      <span>Last duration <b>{snapshot.latest?`${fmt(snapshot.latest.duration_s??snapshot.latest.end-snapshot.latest.onset,2)}s`:'—'}</b></span>
      <span>Peak spacing <b>{snapshot.spacing!=null?`${fmt(snapshot.spacing,2)}s`:'—'}</b></span>
      <span title="At least three resolved usable contractions, separated by 0.4–3 seconds, in the last 10 seconds. Pressure pattern alone does not establish orgasm.">Repeated pulses <b>{snapshot.train.length?`${snapshot.train.length} / 10s`:'—'}</b></span>
    </div>
    <CivetPlot rows={displayRows} events={events} start={start} end={Math.max(end,start+.1)} layers={layers} onSeek={onSeek} markers={markers} playheadS={end}/>
    <div className="civet-plot-key"><span>● Pressure</span><span>━ Tonic</span><span>▰ Contraction duration</span><span>Amber: review</span></div>
    <footer><span title={reprocessed ? 'Recomputed from original pressure samples using the corrected acquisition policy. Original recording preserved.' : undefined}>{review?'Review · noncausal':reprocessed?'Reprocessed · causal replay':'Recorded live · causal'} · {Math.round(end-start)}s · kPa</span><span>White pressure · gold tonic</span></footer>
    {open&&createPortal(<div className="civet-inspector-backdrop"><section role="dialog" aria-modal="true" aria-label="CIVET contraction analysis" className="civet-inspector" onKeyDown={e=>{if(e.key==='Escape')setOpen(false);}}>
      <header><h2>CIVET · Contraction analysis</h2><button autoFocus onClick={()=>setOpen(false)}>Close</button></header>
      <p>Mechanical pressure, not calibrated muscle force. A contraction train is supporting evidence, not proof of orgasm. Amber events need review; their possible causes cannot be distinguished from pressure alone.</p>
      <p>100% means the pressure rise above rest matches your comfortable calibration hold. Higher values can occur; this is not maximum strength or percent toward climax. Rest: {fmt(current?.calibration?.baseline)} kPa · calibration hold rise: {fmt(current?.calibration?.reference)} kPa. Zeroing the hardware is separate from measuring this resting baseline.</p>
      <div className="civet-tools"><label>Analysis <select value={review?'review':reprocessed?'reprocessed':'live'} onChange={e=>{setMode(e.target.value);setSelectedTrain(null);}}>{analysis?.reprocessed&&<option value="reprocessed">Reprocessed pressure (corrected policy)</option>}<option value="live">Recorded live (causal)</option>{analysis?.review&&<option value="review">Retrospective review (noncausal)</option>}</select></label>{Object.keys(layers).map(k=><label key={k}><input type="checkbox" checked={layers[k]} onChange={e=>setLayers(p=>({...p,[k]:e.target.checked}))}/>{k}</label>)}</div>
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
