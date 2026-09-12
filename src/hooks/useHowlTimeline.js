import { useEffect, useState } from 'react';
import { apiUrl } from '../lib/mobileApiBase.js';
export function useHowlTimeline(sessionId) {
  const [state, setState] = useState({ id: null, rows: [], error: null });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    fetch(apiUrl(`/howl/telemetry/session/${encodeURIComponent(sessionId)}`), { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('Could not load saved Howl telemetry.'); return response.json(); })
      .then(data => setState({ id: sessionId, rows: data.samples || [], error: null }))
      .catch(error => { if (!controller.signal.aborted) setState({ id: sessionId, rows: [], error: error.message }); });
    return () => controller.abort();
  }, [sessionId, revision]);
  return { ...(state.id === sessionId ? state : { rows: [], error: null }), retry: () => setRevision(v => v + 1) };
}
