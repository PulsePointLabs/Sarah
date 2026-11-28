import { useEffect, useState } from 'react';
import { apiUrl } from '../lib/mobileApiBase.js';
export function useHowlTimeline(sessionId) {
  const [state, setState] = useState({ id: null, rows: [], error: null });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();let active=true;
    setState(previous=>previous.id===sessionId?{...previous,loading:true,error:null}:{id:sessionId,rows:[],error:null,loading:true});
    fetch(apiUrl(`/howl/telemetry/session/${encodeURIComponent(sessionId)}`), { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('Could not load saved Howl telemetry.'); return response.json(); })
      .then(data => {if(active)setState({ id: sessionId, rows: data.samples || [], error: null,loading:false });})
      .catch(error => { if (active&&!controller.signal.aborted) setState(previous=>({...previous,id:sessionId,error:error.message,loading:false})); });
    return () => {active=false;controller.abort();};
  }, [sessionId, revision]);
  return { ...(state.id === sessionId ? state : { rows: [], error: null,loading:Boolean(sessionId) }), retry: () => setRevision(v => v + 1) };
}
