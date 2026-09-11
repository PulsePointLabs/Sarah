import { useEffect, useRef, useState } from "react";
import { base44 } from "../api/base44Client.js";

export function useSubjectiveEpisodes(session, isExploration) {
  const [episodes, setEpisodes] = useState(session.subjective_near_climax_episodes || []);
  const current = useRef(episodes);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const queue = useRef(Promise.resolve());
  const version = useRef(0);
  const key = `sarah.subjectiveEpisodes.${session.id}`;
  useEffect(() => {
    version.current += 1; setSaving(false); setError("");
    let restored = session.subjective_near_climax_episodes || [];
    try { const pending = localStorage.getItem(key); if (pending) { restored = JSON.parse(pending); setError("Unsaved episode changes recovered. Retry save."); } } catch { /* Saved server records remain available. */ }
    current.current = restored; setEpisodes(restored);
  }, [session.id]);
  const save = (next) => {
    current.current = next; setEpisodes(next); setSaving(true); setError("");
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* The server is the permanent store. */ }
    const thisVersion = ++version.current;
    const entity = isExploration ? base44.entities.BodyExploration : base44.entities.Session;
    queue.current = queue.current.catch(() => {}).then(() => entity.update(session.id, { subjective_near_climax_episodes: next }))
      .then(() => { if (thisVersion === version.current) { setSaving(false); try { localStorage.removeItem(key); } catch { /* Storage can be disabled. */ } } })
      .catch((err) => { if (thisVersion === version.current) { setSaving(false); setError(err.message || "Could not save episode. Your pending change is retained locally."); } });
  };
  return { episodes, current, save, error, saving, retry: () => save(current.current) };
}
