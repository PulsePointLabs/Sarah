import React from 'react';
import {createRoot} from 'react-dom/client';
import AnatomyEvidenceReview from '/src/components/AnatomyEvidenceReview.jsx';
import '/src/index.css';
const findings=[{anatomical_area:'Abdomen',observation:'The subject’s abdomen was visibly braced.',confidence:'low',visibility:'partial',evidence_time_s:72}];
createRoot(document.getElementById('root')).render(<main className="p-8"><h1>Synthetic evidence fixture</h1><AnatomyEvidenceReview findings={findings} frames={[{url:'/__synthetic-evidence.svg',recordTimeSeconds:72}]} onSeek={time=>{window.lastSeek=time;}}/></main>);
