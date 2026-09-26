import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import CivetCard, {CivetSession} from '/src/components/CivetCard.jsx';
import CivetSetup from '/src/components/CivetSetup.jsx';
import VideoSyncPhysiologySidebar from '/src/components/VideoSyncPhysiologySidebar.jsx';
import '/src/index.css';
const samples=Array.from({length:601},(_,i)=>({t:i/10,pressure_kpa:2+Math.sin(i/5),delta_kpa:1+Math.sin(i/5),level_pct:(1+Math.sin(i/5))*50,usable:true,evidence:'contraction',avg_kpa:1,max_kpa:2,contractions_60s:10,duration_s:1}));
function Fixture(){const [time,setTime]=useState(30),[setup,setSetup]=useState(false);return <div className="dark p-2 bg-background text-foreground"><input aria-label="Test playhead" type="range" min="0" max="60" step=".1" value={time} onChange={e=>setTime(+e.target.value)}/><button onClick={()=>setSetup(true)}>Setup</button><div style={{display:'grid',gridTemplateColumns:'1fr 1fr',height:800,gap:8}}><div><div style={{height:260}}><CivetCard rows={samples} playheadS={time} onSeek={setTime}/></div><div style={{height:160}}><CivetCard rows={samples} playheadS={time} compact/></div><CivetSession sessionId="civet-fixture"/></div><VideoSyncPhysiologySidebar timelineRows={[{time_offset_s:0,hr:90}]} civet={{rows:samples}} playheadS={time} onSeek={setTime} compact resizable phaseSession={{}} optionalChannels={{respiration:false,motion:false}}/></div>{setup&&<CivetSetup live={{state:'disconnected',history:[],latest:null}} onClose={()=>setSetup(false)}/>}</div>}
createRoot(document.getElementById('root')).render(<Fixture/>);
