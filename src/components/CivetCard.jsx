import { useMemo, useState } from 'react';
import { civetAt } from '../lib/civet.js';
import { useCivetTimeline } from '../hooks/useCivet.js';
import { apiUrl } from '../lib/mobileApiBase.js';
import './civet.css';
const fmt=(v,d=2)=>v==null?'—':Number(v).toFixed(d);
export default function CivetCard({rows=[],sample,playheadS,onSeek,compact=false,statusText}) {
  const current=sample===undefined?civetAt(rows,playheadS):sample;
  const end=playheadS??current?.t??rows.at(-1)?.t??0,start=Math.max(rows[0]?.t??0,end-30);
  const points=useMemo(()=>rows.filter(p=>p.t>=start&&p.t<=end),[rows,start,end]);
  const min=Math.min(0,...points.map(p=>p.delta_kpa??p.pressure_kpa??0));
  const max=Math.max(.1,...points.map(p=>Math.abs(p.delta_kpa??p.pressure_kpa??0)));
  let previous=null;
  const trace=points.map(p=>{const value=p.delta_kpa??p.pressure_kpa;const move=!previous||p.t-previous.t>.6;previous=p;return `${move?'M':'L'}${((p.t-start)/Math.max(1,end-start)*600).toFixed(2)},${(90-(value-min)/(max-min)*80).toFixed(2)}`;}).join(' ');
  const level=current?.usable?Math.min(100,current.level_pct):null;
  const hue=level==null?200:170-level*1.5;
  return <section className={`civet-card ${compact?'civet-compact':''}`} aria-label="CIVET pelvic pressure" style={{background:`hsl(${hue} 55% ${level==null?11:14+level*.07}% / .95)`,borderColor:`hsl(${hue} 65% 48%)`}}>
    <header><b>CIVET · PELVIC RESPONSE</b><span>{current?.usable?'Relative pressure':'Pressure sensor'}</span></header>
    <div className="civet-main"><strong>{fmt(current?.delta_kpa??current?.pressure_kpa)}<small> kPa{current?.delta_kpa!=null?' Δ':''}</small></strong><b>{fmt(current?.level_pct,0)}<small>% reference</small></b></div>
    <div className="civet-state" title={statusText || current?.evidence}>{statusText || current?.evidence||'No current pressure sample'}{current?.calibration_remaining_s>0?` · ${Math.ceil(current.calibration_remaining_s)}s`:''}</div>
    <div className="civet-stats"><span>30s avg <b>{fmt(current?.avg_kpa)}</b></span><span>30s peak <b>{fmt(current?.max_kpa)}</b></span><span>60s pulses <b>{current?.contractions_60s??'—'}</b></span><span>Hold <b>{fmt(current?.duration_s,1)}s</b></span></div>
    <svg viewBox="0 0 600 100" preserveAspectRatio="none" role="img" aria-label="Pressure response over the last 30 seconds" onClick={onSeek?e=>{const r=e.currentTarget.getBoundingClientRect();onSeek(start+(e.clientX-r.left)/r.width*(end-start));}:undefined}>
      <line x1="0" x2="600" y1="90" y2="90" stroke="#ffffff40"/><path d={trace} fill="none" stroke="#ffffff" strokeWidth="2" vectorEffect="non-scaling-stroke"/>
    </svg>
    <footer><span>{Math.round(end-start)}s pressure window · kPa Δ from baseline</span><span>{current?.rhythm?'Rhythmic contraction evidence':''}</span></footer>
  </section>;
}
export function CivetSession({sessionId}) {
  const {rows,error,retry}=useCivetTimeline(sessionId);const [time,setTime]=useState(null);
  const summary=useMemo(()=>{const valid=rows.filter(p=>p.usable);return {count:rows.reduce((n,p)=>Math.max(n,p.contraction_count||0),0),peak:valid.length?valid.reduce((n,p)=>Math.max(n,p.delta_kpa),0):null,mean:valid.length?valid.reduce((sum,p)=>sum+p.delta_kpa,0)/valid.length:null};},[rows]);
  if(error)return <div className="text-sm">CIVET history unavailable. <button onClick={retry}>Retry</button></div>;
  if(!rows.length)return null;
  const at=time??rows.at(-1).t;
  return <details id="session-civet" className="rounded-xl border border-border p-2" open><summary className="cursor-pointer font-bold text-primary">CIVET · Pelvic pressure</summary>
    <p className="text-sm my-2">Session avg {fmt(summary.mean)} kPa Δ · peak {fmt(summary.peak)} kPa Δ · {summary.count} pressure pulses</p>
    <div style={{height:300}}><CivetCard rows={rows} playheadS={at} onSeek={setTime}/></div>
    <input aria-label="CIVET session time" type="range" min={rows[0].t} max={rows.at(-1).t} step="0.1" value={at} onChange={e=>setTime(Number(e.target.value))} className="w-full"/>
    <a className="text-sm text-primary underline" href={apiUrl(`/civet/session/${encodeURIComponent(sessionId)}/export`)}>Export CIVET CSV</a>
  </details>;
}
