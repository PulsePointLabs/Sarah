import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import LiveSessionConsole from '/src/components/LiveSessionConsole.jsx';
import CivetLiveAlert from '/src/components/CivetLiveAlert.jsx';
import '/src/index.css';
function Fixture(){
 const [recording,setRecording]=useState(null),[session,setSession]=useState(null),[kind,setKind]=useState('session'),[title,setTitle]=useState(''),[notes,setNotes]=useState(''),[civet,setCivet]=useState(false);
 const stale={state:'disconnected',history:[{t:1}],latest:null};
 window.pause=()=>setRecording({active:true,paused:true});window.stop=()=>{setRecording({active:false});setSession({active:false});};
 return <div style={{maxWidth:850,margin:'auto'}}><CivetLiveAlert live={stale} enabled={civet}/><LiveSessionConsole recording={recording} session={session} captureKind={kind} onKindChange={setKind} title={title} notes={notes} onTitleChange={setTitle} onNotesChange={setNotes} onSave={()=>{window.saved={title,notes};}} onStart={()=>{window.started={kind,title,notes};setRecording({active:true});setSession({active:true,captureKind:kind,startedAt:new Date().toISOString()});}} onCamera={()=>{}} hrReady civetEnabled={civet} onCivetChange={setCivet}/></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
