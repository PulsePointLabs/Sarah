import React from 'react';
import { createRoot } from 'react-dom/client';
import ObsRecordingSync from '/src/components/live/ObsRecordingSync.jsx';
import '/src/index.css';
createRoot(document.getElementById('root')).render(<div className="mx-auto max-w-4xl p-6"><ObsRecordingSync /></div>);
