import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import VideoSyncPlayer from '/src/components/VideoSyncPlayer.jsx';
import '/src/index.css';
const rows = Array.from({ length: 180 }, (_, t) => ({ time_offset_s: t, hr: 90 + 15 * Math.sin(t / 20), baseline_hr: 85,
  hrv_rmssd_ms: 25, hrv_sdnn_ms: 35, respiration_bpm: 14, motion_peak_dynamic_mg: 22, signal_confidence_score: 90 }));
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><BrowserRouter>
  <VideoSyncPlayer session={{ id: 'resize-fixture', date: '2026-09-25', duration_minutes: 3, events: [] }} timelineRows={rows} />
</BrowserRouter></QueryClientProvider>);
