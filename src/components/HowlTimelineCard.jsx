import { useMemo, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts';
import { howlTimeline, howlAt, howlClock, howlGraphData, HOWL_GRAPH_GROUPS, howlChangeSummary, howlCommandGraphData } from '../lib/howlTimeline.js';

function ChangeRow({ point, onSeek }) {
  return <div className="border-t border-border/50 py-1.5">
    <div className="flex items-start gap-2 text-xs">
      <button type="button" onClick={()=>onSeek?.(point.t)} className="shrink-0 font-mono text-primary hover:underline">{howlClock(point.t)}</button>
      <span className="min-w-0 break-words">{howlChangeSummary(point)}</span>
      {point.connection_state==='command' && <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">Saved control</span>}
    </div>

  </div>;
}

export default function HowlTimelineCard({ rows = [], error, onRetry, playheadS = 0, xDomain, onSeek, compact = false, offset = 0 }) {
  const [parameter,setParameter]=useState('power');
  const points=useMemo(()=>howlTimeline(rows,offset),[rows,offset]);
  const commandOnly=points.length>0 && points.every(p=>p.connection_state==='command');
  const chartRows=useMemo(()=>commandOnly?howlCommandGraphData(points):howlGraphData(points),[points,commandOnly]);
  const groups=useMemo(()=>HOWL_GRAPH_GROUPS.map(group=>({...group,lines:group.lines.filter(([key])=>chartRows.some(p=>p[key]!=null))})).filter(group=>group.lines.length),[chartRows]);
  const changes=points.filter(p=>p.is_change!==false);
  const selected=groups.find(group=>group.key===parameter)||groups[0];
  const current=howlAt(points,playheadS);
  const start=xDomain?.[0]??0;
  const end=Math.max(start+1,xDomain?.[1]??chartRows.at(-1)?.t??points.at(-1)?.t??1);
  const preview=changes.slice(0,4),remaining=changes.slice(4);
  if(!points.length&&!error)return null;
  const history=<>
    {preview.map(p=><ChangeRow key={p.id} point={p} onSeek={onSeek}/>)}
    {remaining.length>0&&<details className="mt-1 text-xs"><summary className="cursor-pointer text-primary">Show all {changes.length} saved changes</summary>{remaining.map(p=><ChangeRow key={p.id} point={p} onSeek={onSeek}/>)}</details>}
  </>;
  return <section aria-label="Howl settings timeline" className={`relative rounded-xl border border-border bg-background/60 ${compact?(selected?'flex min-h-0 flex-1 flex-col p-1.5':'shrink-0 p-1.5'):'p-3'}`}>
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-primary">{commandOnly?'Howl Â· saved controls':'Howl'}</h3>
      {groups.length>1&&<div aria-label="Howl graph controls" className="flex gap-1">{groups.map(group=><button key={group.key} type="button" aria-pressed={selected.key===group.key} onClick={()=>setParameter(group.key)} className={`rounded-full border px-2 py-0.5 text-[10px] ${selected.key===group.key?'border-primary bg-primary text-primary-foreground':'border-border text-muted-foreground'}`}>{group.label}</button>)}</div>}
    </div>
    {error&&<button type="button" onClick={onRetry} className="text-xs text-destructive">{error} Retry</button>}
    {commandOnly?<p className="my-1 text-xs text-muted-foreground">{changes.length} saved controls · dots show saved power levels only. Changes between them are unknown.</p>:
      <p className="my-1 truncate text-[10px] text-muted-foreground" title={current?howlChangeSummary(current):''}>{current?howlChangeSummary(current):'No Howl reading at this playhead'}</p>}
    {selected&&<>
      {commandOnly && <p className="mb-1 text-[10px] text-muted-foreground">{[...new Set(points.map(p=>p.raw?.command?.activity_display_name||p.raw?.command?.activity_name).filter(Boolean))].join(' · ')}</p>}
      <div className="mb-1 flex shrink-0 items-center gap-3 text-[9px] text-muted-foreground"><span>{selected.label} Â· {selected.unit}</span>{selected.lines.map(([key,label,color])=><span key={key} style={{color}}>{label}</span>)}</div>
      <div className={compact?'min-h-0 flex-1':'h-36 w-full'}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartRows} margin={{top:5,right:12,bottom:0,left:0}} onClick={event=>{if(event?.activeLabel!=null)onSeek?.(Number(event.activeLabel));}}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1}/>
            <XAxis dataKey="t" type="number" domain={[start,end]} allowDataOverflow tickFormatter={howlClock} tick={{fontSize:10,fill:'#94a3b8'}} minTickGap={45}/>
            <YAxis width={38} tick={{fontSize:10,fill:'#94a3b8'}} domain={[0,'auto']}/>
            <Tooltip labelFormatter={t=>howlClock(t)} formatter={(value,name)=>[`${value} ${selected.unit}`,name]} contentStyle={{background:'hsl(var(--popover))',border:'1px solid hsl(var(--border))',borderRadius:8,fontSize:11}}/>
            {selected.lines.map(([key,label,color])=><Line key={key} dataKey={key} name={label} type="stepAfter" stroke={color} strokeWidth={1.5} strokeOpacity={commandOnly?0:1} dot={commandOnly?{r:4,fill:color,strokeWidth:1}:false} activeDot={commandOnly?{r:6}:undefined} connectNulls={false} isAnimationActive={false}/>)}
            {playheadS>=start&&playheadS<=end&&<ReferenceLine x={playheadS} stroke="#94a3b8" strokeDasharray="3 3"/>}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>}
    {compact?<details className="shrink-0 text-[10px]"><summary className="cursor-pointer">Saved changes ({changes.length})</summary><div className="absolute inset-x-0 bottom-full z-30 max-h-[50svh] overflow-y-auto rounded-xl border border-border bg-popover p-3 shadow-xl">{history}</div></details>:
      selected?<details className="mt-2 text-xs"><summary className="cursor-pointer">Saved changes ({changes.length})</summary>{history}</details>:history}
  </section>;
}
