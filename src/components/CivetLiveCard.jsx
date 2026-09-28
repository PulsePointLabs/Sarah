import {useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import { CivetPlot } from './CivetCard.jsx';
import './civetLive.css';
export default function CivetLiveCard({live,onSetup,expanded=false}) {
  const box=useRef(null),[small,setSmall]=useState(false),[open,setOpen]=useState(false);
  useLayoutEffect(()=>{const observer=new ResizeObserver(([entry])=>setSmall(entry.contentRect.height<265||entry.contentRect.width<360));observer.observe(box.current);return()=>observer.disconnect();},[]);
  const s=live.latest, state=s?.acquisition_state;
  const ready=!!s?.usable, level=ready?Math.max(0,Math.min(100,s.level_pct||0)):null;
  const end=s?.t??live.history?.at(-1)?.t??0;
  const rows=s?(live.history||[]).filter(r=>r.t>=end-20):[];
  const early=rows.filter(r=>r.t<end-10),recent=rows.filter(r=>r.t>=end-5);
  const avg=a=>a.reduce((v,r)=>v+r.pressure_kpa,0)/Math.max(1,a.length);
  const diff=recent.length>=35&&early.length>=35?avg(recent)-avg(early):null;
  const trend=rows.some(r=>r.gap)?'Trend interrupted by signal gap':diff==null?'Collecting trend':Math.abs(diff)<.2?'Pressure steady':diff>0?'Pressure trending up':'Pressure trending down';
  const warning=!s?'No fresh signal — check connection':!ready?(state==='settling'?'Release and relax':state==='calibrating'?'Calibration in progress':'Reference uncertain'):null;
  const hue=level==null?40:170-level*1.5;
  return <section ref={box} className={`civet-live-card ${small?'civet-live-small':''} ${ready?'':'civet-live-unready'}`} aria-label="CIVET live pressure" style={{background:`hsl(${hue} 48% ${level==null?14:14+level*.1}%)`}}>
    <header><b>PELVIC PRESSURE</b><button onClick={expanded?onSetup:()=>setOpen(true)}>{expanded?'Calibrate':'Expand'}</button></header>
    {open&&createPortal(<div className="civet-live-expanded"><button className="civet-live-close" onClick={()=>setOpen(false)}>Close monitor</button><CivetLiveCard live={live} onSetup={onSetup} expanded/></div>,box.current?.ownerDocument.body||document.body)}
    <div className="civet-live-state">{warning|| (s.duration_s>=3?'Sustained pressure':s.duration_s>0?'Pressure rising / held':'Resting range')}</div>
    <div className="civet-live-values"><div><strong>{s?Number(s.pressure_kpa).toFixed(1):'—'}</strong><span>Pressure · kPa</span></div><div><strong>{level==null?'—':Math.round(s.level_pct)}<small>{level==null?'':'%'}</small></strong><span>{ready?'Reference intensity':'Intensity uncertain'}</span></div></div>
    <div className="civet-intensity" role="meter" aria-label="Relative pressure intensity" aria-valuemin={0} aria-valuemax={100} aria-valuenow={level??undefined} aria-valuetext={level==null?'Unavailable':`${Math.round(s.level_pct)} percent of reference`}><i style={{width:`${level??0}%`}}/></div>
    <div className="civet-live-stats"><div><b>{ready?`${s.duration_s.toFixed(1)}s`:'—'}</b><span>Hold</span><div className="civet-hold-bar" title="Each full bar represents 10 seconds; the timer continues above it."><i style={{width:`${ready?Math.min(100,s.duration_s*10):0}%`}}/></div></div><div><b>{s?s.contractions_60s:'—'}</b><span>Pulses / 60s{state==='recovering'?' · partial':''}</span></div></div>
    <div className="civet-live-trend">{s?trend:'Waiting for sensor'}{s?.uncertain_pulses_60s>0?` · ${s.uncertain_pulses_60s} uncertain peaks`:''}</div>
    <div className="civet-live-plot"><CivetPlot rows={rows} start={end-20} end={end} layers={{raw:true}}/></div>
  </section>;
}
