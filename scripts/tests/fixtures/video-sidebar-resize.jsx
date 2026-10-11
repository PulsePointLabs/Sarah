import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import VideoSyncPlayer from '/src/components/VideoSyncPlayer.jsx';
import '/src/index.css';
import { createCivetProcessor } from '/src/lib/civet.js';
import { reprocessCivetRecording } from '/src/lib/civetReprocess.js';
const processor = createCivetProcessor();
processor.calibrate('baseline'); for(let i=0;i<=50;i++) processor.ingest(2,i/10);
processor.calibrate('reference'); for(let i=51;i<=101;i++) processor.ingest(4,i/10);
for(let i=102;i<=141;i++) processor.ingest(2,i/10);
processor.reset();
const pressureRows=Array.from({length:601},(_,i)=>processor.ingest(2+Math.max(0,Math.sin(i/10*Math.PI*2/1.2))*1.8,i/10));
window.civetFixture={samples:pressureRows,analysis:{reprocessed:reprocessCivetRecording(pressureRows)}};
if(new URLSearchParams(location.search).has('missingPressure')) window.civetFixture={samples:pressureRows.map(row=>({...row,t:row.t+100})),analysis:{}};
const rows = Array.from({ length: 180 }, (_, t) => ({ time_offset_s: t, hr: 90 + 15 * Math.sin(t / 20), baseline_hr: 85,
  hrv_rmssd_ms: 25, hrv_sdnn_ms: 35, respiration_bpm: 14, motion_peak_dynamic_mg: 22, signal_confidence_score: 90 }));
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><BrowserRouter>
  <VideoSyncPlayer session={{ id: 'resize-fixture', date: '2026-09-25', duration_minutes: 3, events: [] }} timelineRows={rows} />
</BrowserRouter></QueryClientProvider>);
