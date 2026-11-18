import React from 'react';import {createRoot} from 'react-dom/client';
import ViewportTelemetryGrid from '/src/components/ViewportTelemetryGrid.jsx';
import CivetLiveCard from '/src/components/CivetLiveCard.jsx';import HowlLiveCard from '/src/components/HowlLiveCard.jsx';
import '/src/index.css';
const sample={measured_at:new Date().toISOString(),power_a:45,power_b:32,mute:false,player:{playing:true,title:'Fixture pattern'}};
function Panel(){return null;}
function Metric({label,value}){return <div className="telemetry-metric-card rounded-xl border border-slate-600 bg-slate-900 text-white"><div>{label}</div><div className="telemetry-metric-main"><div className="telemetry-metric-value"><div>{value}</div></div><svg viewBox="0 0 100 30"><path d="M0 20L20 10L40 15L60 5L100 13" fill="none" stroke="cyan"/></svg></div><div className="telemetry-metric-helper">Live reading · quality high</div></div>;}
function Fixture(){return <main style={{height:'100dvh',width:'100vw',display:'flex',flexDirection:'column',overflow:'hidden',background:'#07131c'}}><ViewportTelemetryGrid enabled>
 <Panel id="vitals"><div>{[['Current HR','98'],['Blood Pressure','124/86'],['RMSSD','42.5'],['SDNN','35.6'],['Recovery','12']].map(([label,value])=><Metric key={label} label={label} value={value}/>)}</div></Panel>
 <Panel id="civet" label="Pelvic pressure"><CivetLiveCard live={{state:'not_in_use',latest:null,history:[]}} onSetup={()=>{}}/></Panel>
 <Panel id="howl" label="Howl monitor"><HowlLiveCard sample={sample} onControls={()=>{window.controlsOpened=true;}}/></Panel>
 <Panel id="cardiac" label="Cardiac trend"><div style={{color:'white',background:'#12303a'}}><p>Cardiac trend</p><svg width="100%" height="70%" viewBox="0 0 300 100"><text x="10" y="20">Measured heart rate</text><path d="M0 90L100 30L200 60L300 20" stroke="cyan" fill="none"/></svg></div></Panel>
 </ViewportTelemetryGrid></main>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
