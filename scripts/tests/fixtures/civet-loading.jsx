import React from 'react';
import {createRoot} from 'react-dom/client';
import {useCivetTimeline} from '/src/hooks/useCivet.js';
import VideoSyncPhysiologySidebar from '/src/components/VideoSyncPhysiologySidebar.jsx';
import '/src/index.css';
function Fixture() {
  const id=new URLSearchParams(location.search).get('session') || 'fixture';
  const civet=useCivetTimeline(id);
  return <div className="dark bg-background text-foreground" style={{height:900,width:700}}>
    <output aria-label="Saved sample count">{civet.rows.length}</output>
    <VideoSyncPhysiologySidebar civet={civet} timelineRows={[{time_offset_s:0,hr:90,hrv_rmssd_ms:25}]} playheadS={60} compact resizable phaseSession={{}} />
  </div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
