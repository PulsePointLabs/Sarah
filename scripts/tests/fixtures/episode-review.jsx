import React from 'react';
import {createRoot} from 'react-dom/client';
import SubjectiveNearClimaxEpisodes from '/src/components/SubjectiveNearClimaxEpisodes.jsx';
import '/src/index.css';
const episodes=[{id:'n',kind:'near_climax',start_s:15,end_s:25,duration_s:10,source:{key:'main',label:'Main'}}];
createRoot(document.getElementById('root')).render(<div className="bg-background text-foreground p-5"><SubjectiveNearClimaxEpisodes recordId="episode-test" episodes={episodes} timelineRows={[]} onSeek={e=>window.lastSeek=e.start_s} onSeekTime={t=>window.lastSeek=t} onToggle={()=>{}} onDelete={()=>{}} onRetry={()=>{}}/></div>);
