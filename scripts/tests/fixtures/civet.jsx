import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import CivetCard, {CivetSession} from '/src/components/CivetCard.jsx';
import CivetSetup from '/src/components/CivetSetup.jsx';
import VideoSyncPhysiologySidebar from '/src/components/VideoSyncPhysiologySidebar.jsx';
import '/src/index.css';
import {createCivetProcessor} from '/src/lib/civet.js';
import {analyzeCivetReview,linkIntervals,summarizeTrains} from '/src/lib/civetAnalysis.js';
import {reprocessCivetRecording} from '/src/lib/civetReprocess.js';
const processor=createCivetProcessor();
processor.calibrate('baseline');for(let i=0;i<=50;i++)processor.ingest(2,i/10);
processor.calibrate('reference');for(let i=51;i<=101;i++)processor.ingest(4,i/10);
for(let i=102;i<=141;i++)processor.ingest(2,i/10);
processor.reset();
const samples=Array.from({length:601},(_,i)=>processor.ingest(2+Math.max(0,Math.sin(i/10*Math.PI*2/1.2))*1.8,i/10));
const events=linkIntervals(samples.flatMap(r=>r.events));
const analysis={reprocessed:reprocessCivetRecording(samples),review:analyzeCivetReview(samples),live:{rows:samples,events,trains:summarizeTrains(events,samples)}};
function Fixture(){const [time,setTime]=useState(30),[setup,setSetup]=useState(false);return <div className="dark p-2 bg-background text-foreground" style={{position:"relative",zIndex:11000}}><input aria-label="Test playhead" type="range" min="0" max="60" step=".1" value={time} onChange={e=>setTime(+e.target.value)}/><button onClick={()=>setSetup(true)}>Setup</button><div style={{display:'grid',gridTemplateColumns:'1fr 1fr',height:800,gap:8}}><div><div style={{height:260}}><CivetCard rows={samples} analysis={analysis} sessionId="fixture" markers={[{t:30,label:"Manual climax"}]} playheadS={time} onSeek={setTime}/></div><div style={{height:160}}><CivetCard rows={samples} playheadS={time} compact/></div><CivetSession sessionId="civet-fixture"/></div><VideoSyncPhysiologySidebar timelineRows={[{time_offset_s:0,hr:90,hrv_rmssd_ms:25,hrv_sdnn_ms:35,respiration_bpm:14,motion_peak_dynamic_mg:22}]} civet={{rows:samples,analysis,sessionId:"fixture"}} playheadS={time} onSeek={setTime} compact resizable phaseSession={{}} optionalChannels={{respiration:true,motion:true}}/></div>{setup&&<CivetSetup live={{state:'disconnected',history:[],latest:null}} onClose={()=>setSetup(false)}/>}</div>}
createRoot(document.getElementById('root')).render(<Fixture/>);

