import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveCueAudio } from './useLiveCueAudio';
import { initialPhaseAnnouncementState, PHASE_PHRASES, PHASE_SETTINGS_KEY, stepPhaseAnnouncement } from '@/lib/phaseAnnouncements';

export function usePhaseAnnouncements({ prediction, sample, voiceSettings, sessionId, microphoneActive }) {
  const [settings, setSettings] = useState(() => {
    try { const stored = JSON.parse(localStorage.getItem(PHASE_SETTINGS_KEY) || '{}'); return { enabled: stored.enabled === true, volume: Math.max(0, Math.min(1, Number(stored.volume ?? 0.5))) }; }
    catch { return { enabled: false, volume: 0.5 }; }
  });
  const audioSettings = useMemo(() => ({ ...voiceSettings, volume: settings.volume }), [voiceSettings, settings.volume]);
  const audio = useLiveCueAudio({ phrases: PHASE_PHRASES, settings: audioSettings, enabled: settings.enabled });
  const state = useRef(initialPhaseAnnouncementState());
  const [message, setMessage] = useState('');
  const inputs = useRef();
  inputs.current = { prediction, sample, settings, audio, microphoneActive };
  useEffect(() => { try { localStorage.setItem(PHASE_SETTINGS_KEY, JSON.stringify(settings)); } catch {} }, [settings]);
  useEffect(() => { state.current = initialPhaseAnnouncementState(); setMessage(''); audio.stop(); }, [sessionId, settings.enabled, audio.stop]);
  useEffect(() => {
    const tick = () => {
      const input = inputs.current;
      const result = stepPhaseAnnouncement(state.current, input.prediction, { ...input.sample, enabled: input.settings.enabled });
      state.current = result.state;
      if (!result.cue || input.microphoneActive) return;
      const playback = input.audio.playCue(result.cue);
      if (playback.ok) {
        state.current = { ...result.state, lastPhase: result.cue.type, lastSpokenAt: result.cue.atMs };
        setMessage(`Last announced: ${result.cue.phrase}`);
      }
    };
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (settings.enabled && audio.status.phase === 'idle') audio.prepare().catch(() => {});
  }, [settings.enabled, audio.prepare, audio.status.phase]);
  const toggle = useCallback(() => {
    if (settings.enabled) audio.stop();
    else audio.unlock().catch((error) => setMessage(error.message));
    setSettings((previous) => ({ ...previous, enabled: !previous.enabled }));
  }, [settings.enabled, audio.stop, audio.unlock]);
  const test = useCallback(async () => {
    try { const result = await audio.testVoice(); setMessage(result.ok ? 'Phase announcement audio is ready.' : `Audio not ready: ${result.reason}`); }
    catch (error) { setMessage(error.message); }
  }, [audio.testVoice]);
  return { settings, setSettings, audio, toggle, test, message };
}
