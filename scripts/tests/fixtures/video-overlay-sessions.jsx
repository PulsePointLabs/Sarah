import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {BrowserRouter} from 'react-router-dom';
import VideoSyncPlayer from '/src/components/VideoSyncPlayer.jsx';
import '/src/index.css';
function Fixture(){
 const [record,setRecord]=useState('a');window.overlaySessionFixture={switchRecord:()=>setRecord(previous=>previous==='a'?'b':'a')};
 const rows=Array.from({length:120},(_,time_offset_s)=>({time_offset_s,hr:(record==='a'?90:110)+Math.sin(time_offset_s/10)*3,baseline_hr:80,...(record==='a'?{hrv_rmssd_ms:24,hrv_sdnn_ms:32}:{})}));
 return <VideoSyncPlayer key={record} session={{id:record,date:'2026-11-26',duration_minutes:2,event_timeline:[]}} timelineRows={rows}/>;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><BrowserRouter><Fixture/></BrowserRouter></QueryClientProvider>);
