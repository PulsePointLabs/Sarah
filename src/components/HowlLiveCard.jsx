import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {howlLiveView} from '@/lib/howlLiveView.js';
import './howlLiveCard.css';
function Trace({values,color,label}){
  const max=Math.max(1,...values.map(Math.abs));
  const path=values.map((value,i)=>`${i?'L':'M'}${i*300/Math.max(1,values.length-1)},${40-value/max*30}`).join(' ');
  return <svg viewBox="0 0 300 80" preserveAspectRatio="none" role="img" aria-label={label}><path d="M0 40H300" stroke="#35505d"/><path d={path} stroke={color} fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke"/></svg>;
}
export default function HowlLiveCard({sample,onControls,expanded=false}){
  const root=useRef(null),[open,setOpen]=useState(false),[history,setHistory]=useState([]),[now,setNow]=useState(Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  const view=howlLiveView(sample,now);
  useEffect(()=>{const v=howlLiveView(sample);if(v.fresh)setHistory(old=>[...old,{at:sample.measured_at||sample.received_at,a:v.channels[0].power,b:v.channels[1].power}].slice(-60));},[sample]);
  return <section ref={root} className={`howl-live-card ${expanded?'howl-live-expanded-card':''}`} aria-label="Howl device telemetry">
    <header><b>Howl · channel monitor</b><span>{view.fresh?view.muted?'Muted':view.playing?'Running':'Device connected':'No fresh device status'}</span></header>
    <div className="howl-live-channels">{view.channels.map((channel,i)=><div key={channel.key} className="howl-live-channel" style={{'--channel-color':i?'#bd94ff':'#40dcc4'}}>
      <div className="howl-channel-label"><b>Channel {channel.key.toUpperCase()}</b><span data-output-state={channel.active===true?'on':channel.active===false?'off':'unknown'}>{channel.active===true?'Device reports output':channel.active===false?'Output off':'Pulse state not reported'}</span></div>
      <div className="howl-live-level"><strong>{channel.power??'—'}</strong><span>level{channel.current!=null?` · ${channel.current} mA reported`:''}{channel.frequency!=null?` · ${channel.frequency} Hz`:''}</span></div>
      <Trace values={channel.samples.length?channel.samples:history.map(row=>row[channel.key]).filter(v=>v!=null)} color={i?'#bd94ff':'#40dcc4'} label={`Channel ${channel.key.toUpperCase()} ${channel.samples.length?'device waveform':'reported level history'}`}/>
      <small>{channel.samples.length?'Device-supplied waveform samples':'Reported level history · electrical waveform not supplied'}</small>
    </div>)}</div>
    <footer><span title={view.activity}>{view.activity}</span><button type="button" onClick={onControls}>Adjust settings</button>{!expanded&&<button type="button" onClick={()=>setOpen(true)}>Expand</button>}</footer>
    {open&&createPortal(<div className="howl-live-modal"><button className="howl-live-close" onClick={()=>setOpen(false)}>Close monitor</button><HowlLiveCard sample={sample} expanded onControls={()=>{setOpen(false);onControls?.();}}/></div>,root.current?.ownerDocument.fullscreenElement||document.body)}
  </section>;
}
