import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {BrowserRouter} from 'react-router-dom';
import VideoSyncPlayer from '/src/components/VideoSyncPlayer.jsx';
import '/src/index.css';
const rows=Array.from({length:30},(_,time_offset_s)=>({time_offset_s,hr:90,baseline_hr:80}));
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><BrowserRouter><VideoSyncPlayer recordType={new URLSearchParams(location.search).has('body')?'body_exploration':'session'} session={{id:'visual-fixture',date:'2026-11-21',duration_minutes:1,event_timeline:window.visualFixtureEvents||[]}} timelineRows={rows}/></BrowserRouter></QueryClientProvider>);
