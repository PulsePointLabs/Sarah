import './monitorTrendChart.css';
import {useId,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import EpisodeBoundaryHandle from './EpisodeBoundaryHandle.jsx';
import {monitorBounds,monitorNiceTicks,monitorPath} from '../lib/monitorChartGeometry.js';

// SVG port of Sarah Monitor ui/Charts.kt: label-aware insets/tick density,
// three time labels, horizontal monitor grid, round linear traces and open gaps.
export default function MonitorTrendChart({rows=[],lines=[],xDomain=[0,60],playheadS,onSeek,minSpan=10,fixedBounds,gapSeconds=30,breakBefore,fill=false,dots=false,drawLines=true,phaseBands=[],subjectiveEpisodes=[],onEpisodeEdit,onEpisodeEditStart,onEpisodePreview,markers=[]}){
  const root=useRef(null),[size,setSize]=useState({width:400,height:180}),[hover,setHover]=useState(null),clip=useId().replaceAll(':','');
  useLayoutEffect(()=>{const el=root.current,win=el.ownerDocument.defaultView,measure=()=>{const r=el.getBoundingClientRect();if(r.width>0&&r.height>0)setSize(old=>Math.abs(old.width-r.width)<.5&&Math.abs(old.height-r.height)<.5?old:{width:r.width,height:r.height});};const observer=new win.ResizeObserver(measure);observer.observe(el);win.addEventListener('resize',measure);measure();return()=>{observer.disconnect();win.removeEventListener('resize',measure);};},[]);
  const start=xDomain[0],end=Math.max(start+.1,xDomain[1]),label=12,left=label*3.2,right=Math.max(left+1,size.width-8),top=label*.8,bottom=Math.max(top+4,size.height-label*1.6),visible=useMemo(()=>rows.filter(row=>row.t>=start&&row.t<=end),[rows,start,end]);
  const [low,high]=monitorBounds(visible.flatMap(row=>lines.map(line=>row[line.key])),minSpan,fixedBounds);
  const x=t=>left+(t-start)/(end-start)*(right-left),y=value=>bottom-(value-low)/(high-low)*(bottom-top),clock=t=>`${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}`;
  const ticks=monitorNiceTicks(low,high,Math.max(1,Math.min(4,Math.floor((bottom-top)/(label*2.2)))));
  const heartValues=lines.some(line=>line.key==='hr')?visible.map(row=>row.hr).filter(Number.isFinite):[];
  const average=heartValues.length?heartValues.reduce((sum,v)=>sum+v,0)/heartValues.length:null;
  const timeAt=event=>{const r=root.current.getBoundingClientRect();return Math.max(start,Math.min(end,start+((event.clientX-r.left)/r.width*size.width-left)/(right-left)*(end-start)));};
  const tooltip=hover&&root.current?(()=>{const doc=root.current.ownerDocument,win=doc.defaultView;let nearest=null,distance=Infinity;for(const row of visible){const next=Math.abs(row.t-hover.t);if(next<distance){nearest=row;distance=next;}}if(!nearest)return null;return createPortal(<div role="tooltip" className="monitor-trend-tooltip" style={{left:Math.max(8,Math.min(win.innerWidth-230,hover.x+12)),top:Math.max(8,Math.min(win.innerHeight-130,hover.y+12))}}><b>{clock(nearest.t)}</b>{lines.map(line=><span key={line.key} style={{color:line.color}}>{line.label}: {Number.isFinite(nearest[line.key])?Number(nearest[line.key]).toFixed(line.decimals??0):'—'}</span>)}</div>,doc.fullscreenElement||doc.body);})():null;
  return <div ref={root} className="monitor-trend-chart" onPointerLeave={()=>setHover(null)} onPointerMove={event=>{if(event.pointerType==='mouse'&&!event.buttons)setHover({t:timeAt(event),x:event.clientX,y:event.clientY});}}>
    <svg role="img" data-monitor-port="trend-v1" aria-label={lines.map(line=>line.label).join(' and ')+' over session time'} width="100%" height="100%" viewBox={`0 0 ${size.width} ${size.height}`} onClick={event=>onSeek?.(timeAt(event))}>
      <defs><clipPath id={clip}><rect x={left} y={top} width={right-left} height={bottom-top}/></clipPath></defs>
      <g className="monitor-trend-grid">{ticks.map(value=><line key={value} x1={left} x2={right} y1={y(value)} y2={y(value)} stroke="#13202e"/>)}</g>
      {ticks.map(value=><text key={value} x={left-5} y={y(value)+label*.35} textAnchor="end">{value.toFixed(high-low<3?1:0)}</text>)}
      {[start,(start+end)/2,end].map((time,i)=><text key={i} x={x(time)} y={size.height-2} textAnchor={i===0?'start':i===2?'end':'middle'}>{clock(time)}</text>)}
      <g clipPath={`url(#${clip})`}>
        {phaseBands.map((band,i)=><rect key={i} x={x(Math.max(start,band.start))} y={top} width={Math.max(0,x(Math.min(end,band.end))-x(Math.max(start,band.start)))} height={bottom-top} fill={band.color||'#34e37e'} opacity=".07"/>)}
        {lines.map(line=>{const path=monitorPath(visible,line.key,{start,end,x,y,gapSeconds,breakBefore});return <g key={line.key}>{fill&&path.split(/(?=M)/).filter(Boolean).map((segment,i)=>{const matches=[...segment.matchAll(/[ML]([\d.-]+),([\d.-]+)/g)];if(matches.length<2)return null;return <path key={i} d={`M${matches[0][1]},${y(Math.max(low,Math.min(high,0)))} ${segment.replace(/^M/,'L')} L${matches.at(-1)[1]},${y(Math.max(low,Math.min(high,0)))} Z`} fill={line.color} opacity=".12"/>;})}{drawLines&&<path data-monitor-series={line.key} d={path} fill="none" stroke={line.color} strokeWidth={line.width||1.8} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={line.dash}/>}{dots&&visible.filter(row=>Number.isFinite(row[line.key])).map((row,i)=><circle key={i} cx={x(row.t)} cy={y(row[line.key])} r="3" fill={line.color}/>)}</g>;})}
        {Number.isFinite(playheadS)&&playheadS>=start&&playheadS<=end&&<line x1={x(playheadS)} x2={x(playheadS)} y1={top} y2={bottom} stroke="#8ca3b8" strokeDasharray="3 3" opacity=".6"/>}
        {average!=null&&<g><line x1={left} x2={right} y1={y(average)} y2={y(average)} stroke="#8ca3b8" opacity=".7" strokeDasharray="10 8"/><text x={right-4} y={Math.max(top+12,y(average)-3)} textAnchor="end">avg {Math.round(average)}</text></g>}
        {markers.filter(marker=>marker.t>=start&&marker.t<=end).map((marker,i)=><g key={i}><line x1={x(marker.t)} x2={x(marker.t)} y1={top} y2={bottom} stroke="#b794ff" strokeDasharray="2 3"/><title>{marker.label}</title></g>)}
      </g>
      {subjectiveEpisodes.flatMap(episode=>['start_s','end_s'].filter(boundary=>Number.isFinite(episode[boundary])&&episode[boundary]>=start&&episode[boundary]<=end).map(boundary=>onEpisodeEdit?<EpisodeBoundaryHandle key={episode.id+boundary} x1={x(episode[boundary])} y1={top} y2={bottom} plotWidth={right-left} stroke={episode.kind==='climax'?'#e879f9':'#a78bfa'} episode={episode} boundary={boundary} domain={[start,end]} onStart={onEpisodeEditStart} onPreview={onEpisodePreview} onCommit={onEpisodeEdit}/>:<line key={episode.id+boundary} x1={x(episode[boundary])} x2={x(episode[boundary])} y1={top} y2={bottom} stroke="#b794ff" strokeDasharray="3 3"/>))}
    </svg>{tooltip}
  </div>;
}
