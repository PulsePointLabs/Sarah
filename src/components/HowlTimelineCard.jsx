import { useMemo, useState } from 'react';
import { howlTimeline, howlAt, howlClock, howlStepPath } from '../lib/howlTimeline.js';

export default function HowlTimelineCard({ rows = [], error, onRetry, playheadS = 0, xDomain, onSeek, compact = false, offset = 0 }) {
  const [parameter, setParameter] = useState('power');
  const points = useMemo(() => howlTimeline(rows, offset), [rows, offset]);
  const keys = useMemo(() => [...new Set(points.flatMap(p => Object.entries(p.fields).filter(([,v]) => typeof v === 'number').map(([k]) => k)))].sort(), [points]);
  if (!points.length && !error) return null;
  const selected = parameter === 'power' || keys.includes(parameter) ? parameter : 'power';
  const current = howlAt(points, playheadS);
  const start = xDomain?.[0] ?? Math.max(0, points[0]?.t || 0);
  const end = Math.max(start+1, xDomain?.[1] ?? (points.at(-1)?.t || 1)+1);
  const max = Math.max(1, ...points.map(p => selected === 'power' ? Math.max(p.powerA || 0, p.powerB || 0) : Number(p.fields[selected]) || 0));
  const changes = points.filter(p=>p.is_change !== false);
  const frequencyAvailable = keys.some(k=>/freq|hz/i.test(k));
  const details = <>
    <p>Observed Howl settings; timestamps are desktop receipt times. Checks every 0.5s; brief changes between checks can be missed. Blank graph spans mean no recent observation.</p>
    {!frequencyAvailable && <p>Hz / generator parameters are not reported by this Howl API.</p>}
    {current && <dl className="mt-2 grid grid-cols-2 gap-1">{Object.entries(current.fields).map(([key,value])=><div key={key} className="min-w-0 break-words"><dt className="text-muted-foreground">{key}</dt><dd>{String(value)}</dd></div>)}</dl>}
    <p className="mt-2 font-semibold">All recorded changes ({changes.length})</p>
    {changes.map(p=><details key={p.id} className="mt-1 border-t border-border pt-1"><summary><button type="button" onClick={()=>onSeek?.(p.t)} className="text-primary underline">{howlClock(p.t)}</button> · {p.connection_state==='disconnected'?'Connection lost':p.connection_state==='command'?`Sarah command note: ${p.title}`:p.title} · A {p.powerA ?? '—'} / B {p.powerB ?? '—'}</summary>
      <dl className="grid grid-cols-2 gap-1">{Object.entries(p.fields).map(([key,value])=><div key={key} className="break-words"><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></details>)}
  </>;
  return <section aria-label="Howl settings timeline" className={`relative rounded-xl border border-violet-400/25 bg-card ${compact?'flex min-h-0 flex-1 flex-col p-1.5':'p-3'}`}>
    <div className="flex shrink-0 items-center justify-between gap-2"><h3 className="text-[10px] font-semibold uppercase tracking-wider text-violet-300">Howl settings</h3>
      <select aria-label="Howl graph parameter" value={selected} onChange={e=>setParameter(e.target.value)} className="min-w-0 max-w-[55%] rounded border border-border bg-background text-[10px]">
        <option value="power">Channel A / B power</option>{keys.map(k=><option key={k} value={k}>{k}</option>)}
      </select></div>
    {points.length > 0 && points.every(p => p.connection_state === "command") && <p className="text-[10px] text-muted-foreground">Only Sarah command notes were saved; continuous Howl telemetry was not recorded for this session.</p>}
    {error && <button type="button" onClick={onRetry} className="text-xs text-destructive">{error} Retry</button>}
    <p className="truncate text-[10px]" title={current?.title}>{current ? `${current.title} · A ${current.powerA ?? '—'} / B ${current.powerB ?? '—'}${current.mute ? ' · Muted':''}${current.player?.playing === false ? ' · Stopped':''}` : 'No recent Howl observation at this time'}</p>
    <svg viewBox="0 0 400 98" preserveAspectRatio="none" role="img" aria-label="Recorded Howl parameters over session time" className={compact?'min-h-0 w-full flex-1':'h-32 w-full'}
      onClick={e=>{const r=e.currentTarget.getBoundingClientRect();onSeek?.(start+Math.max(0,Math.min(1,((e.clientX-r.left)/r.width*400-30)/360))*(end-start));}}>
      {[0,max].map(n=><g key={n}><line x1="30" x2="390" y1={78-n/max*65} y2={78-n/max*65} stroke="currentColor" opacity=".15"/><text x="0" y={81-n/max*65} fontSize="8" fill="currentColor">{Math.round(n*10)/10}</text></g>)}
      <path d={howlStepPath(points,selected==='power'?'powerA':selected,start,end,max)} fill="none" stroke="#2dd4bf" strokeWidth="2"/>
      {selected==='power'&&<path d={howlStepPath(points,'powerB',start,end,max)} fill="none" stroke="#c084fc" strokeWidth="2"/>}
      {playheadS>=start&&playheadS<=end&&<line x1={30+(playheadS-start)/(end-start)*360} x2={30+(playheadS-start)/(end-start)*360} y1="8" y2="80" stroke="currentColor" strokeDasharray="2 2"/>}
      <text x="30" y="95" fontSize="8" fill="currentColor">{howlClock(start)}</text><text x="390" y="95" textAnchor="end" fontSize="8" fill="currentColor">{howlClock(end)}</text>
    </svg>
    <div className="flex shrink-0 justify-between text-[9px]"><span className="text-teal-300">{selected==='power'?'A power':selected}</span>{selected==='power'&&<span className="text-purple-300">B power</span>}<span>{frequencyAvailable?'Hz reported':'Hz not reported'}</span></div>
    <details className="shrink-0 text-[10px]"><summary className="cursor-pointer">Parameters & change log</summary><div className={compact?'absolute inset-x-0 bottom-full z-30 max-h-[50svh] overflow-y-auto rounded-xl border border-border bg-popover p-3 shadow-xl':'mt-2'}>{details}</div></details>
  </section>;
}
