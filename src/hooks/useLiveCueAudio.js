import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl, serverUrl } from "@/lib/mobileApiBase";
import { LIVE_CUE_PROFILE_VERSION } from "@/lib/liveCuePhrases";
import { resumeLiveCueContext } from "@/lib/liveCueAudioReadiness";
import { loadTTSSettings } from "@/components/TTSButton";

// Independent controls share the speaker without talking over one another.
let speaking = null;

function flattenCueClips(phrases = {}) {
  const clips = [];
  Object.entries(phrases || {}).forEach(([type, values]) => {
    (values || []).forEach((text, index) => {
      if (String(text || "").trim()) clips.push({ type, index, text: String(text).trim() });
    });
  });
  return clips;
}

async function decodeClip(ctx, clip) {
  const clipUrl = String(clip?.url || "").startsWith("/live-cues/")
    ? apiUrl(String(clip.url).replace(/^\/live-cues/, "/live-cues"))
    : serverUrl(clip.url);
  const response = await fetch(clipUrl, { cache: "force-cache", signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Cue audio fetch failed (${response.status})`);
  const contentType = response.headers.get("content-type") || "";
  if (contentType && !contentType.toLowerCase().startsWith("audio/") && !contentType.toLowerCase().includes("octet-stream")) {
    throw new Error(`Cue audio returned ${contentType || "non-audio data"} instead of audio.`);
  }
  const arrayBuffer = await response.arrayBuffer();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    throw new Error(`Unable to decode cue audio${contentType ? ` (${contentType})` : ""}.`);
  }
  return { ...clip, audioBuffer: decoded };
}

export function useLiveCueAudio({ phrases, settings, enabled = true } = {}) {
  const audioContextRef = useRef(null);
  const gainRef = useRef(null);
  const activeSourceRef = useRef(null);
  const ownerRef = useRef(Symbol('live-voice'));
  const decodedRef = useRef(new Map());
  const prepareRef = useRef(null);
  const generationRef = useRef(0);
  const [audioState, setAudioState] = useState("suspended");
  const phraseSignature = useMemo(() => JSON.stringify(phrases || {}), [phrases]);
  const [status, setStatus] = useState({ phase: enabled ? "idle" : "disabled", message: "", decoded: 0, total: 0 });

  const getAudioContext = useCallback(() => {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) throw new Error("Web Audio is unavailable in this browser.");
    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      audioContextRef.current = new AudioCtor();
      gainRef.current = audioContextRef.current.createGain();
      gainRef.current.gain.value = Math.max(0, Math.min(1, Number(settings?.volume ?? 0.28)));
      gainRef.current.connect(audioContextRef.current.destination);
      audioContextRef.current.onstatechange = () => setAudioState(audioContextRef.current?.state || "closed");
    }
    // Decode while suspended; do not wait for a gesture during background preparation.
    return audioContextRef.current;
  }, [settings?.volume]);

  const unlock = useCallback(async () => {
    const ctx = getAudioContext();
    await resumeLiveCueContext(ctx);
    setAudioState(ctx.state);
    const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gainRef.current);
    source.start();
    return ctx.state === "running";
  }, [getAudioContext]);

  const prepare = useCallback(() => {
    if (prepareRef.current) return prepareRef.current;
    const generation = generationRef.current;
    const operation = (async () => {
      if (!enabled) {
        setStatus({ phase: "disabled", message: "Sarah voice cues disabled.", decoded: 0, total: 0 });
        return { ok: false, disabled: true };
      }
      const requested = flattenCueClips(phrases);
      if (!requested.length) {
        setStatus({ phase: "disabled", message: "No live cue phrases enabled.", decoded: 0, total: 0 });
        return { ok: false, disabled: true };
      }
      setStatus({ phase: "preparing", message: "Preparing Sarah voice cues...", decoded: 0, total: requested.length });
      const ctx = await getAudioContext();
      const ttsProvider = settings?.ttsProvider || loadTTSSettings().ttsProvider;
      const response = await fetch(apiUrl("/live-cues/prepare"), {
        signal: AbortSignal.timeout(180000),
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clips: requested,
          voice: settings?.voice || "nova",
          model: settings?.model || "tts-1-hd",
          speed: settings?.speed || 1,
          format: settings?.format || "mp3",
          ttsProvider,
          profileVersion: LIVE_CUE_PROFILE_VERSION,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Sarah voice cues could not be prepared.");
      }
      const decoded = new Map();
      const decodeFailures = [];
      for (const prepared of payload.clips || []) {
        if (generation !== generationRef.current) return { ok: false, cancelled: true };
        const source = requested.find((clip) => clip.text === prepared.text);
        try {
          const clip = await decodeClip(ctx, { ...source, ...prepared });
          decoded.set(`${clip.type}:${clip.text}`, clip);
        } catch (error) {
          decodeFailures.push({ text: prepared.text, error: error?.message || String(error) });
        }
        if (generation !== generationRef.current) return { ok: false, cancelled: true };
        setStatus({ phase: "preparing", message: "Decoding Sarah voice cues...", decoded: decoded.size, total: requested.length });
      }
      if (generation !== generationRef.current) return { ok: false, cancelled: true };
      if (!decoded.size) {
        throw new Error(decodeFailures[0]?.error || "Sarah voice cues could not be decoded on this device.");
      }
      decodedRef.current = decoded;
      const skipped = Number(payload.failures?.length || 0) + decodeFailures.length;
      setStatus({
        phase: "ready",
        message: skipped ? `Sarah voice ready (${decoded.size} clips; ${skipped} unavailable).` : "Sarah voice cues preloaded.",
        decoded: decoded.size,
        total: requested.length,
      });
      return { ok: true, partial: skipped > 0, decoded: decoded.size, total: requested.length, skipped };
    })().catch((error) => {
      if (generation === generationRef.current) setStatus({ phase: "error", message: error?.message || "Voice preparation failed. Tap Test voice to retry.", decoded: 0, total: 0 });
      throw error;
    }).finally(() => {
      if (prepareRef.current === operation) prepareRef.current = null;
    });
    prepareRef.current = operation;
    return operation;
  }, [enabled, getAudioContext, phrases, settings?.format, settings?.model, settings?.speed, settings?.voice, settings?.ttsProvider]);

  const playCue = useCallback((cue, { freshnessMs = 2500 } = {}) => {
    if (!enabled) return { ok: false, reason: "disabled" };
    if (speaking && speaking.owner !== ownerRef.current) return { ok: false, reason: "voice_busy" };
    const ctx = audioContextRef.current;
    if (!ctx || ctx.state !== "running") return { ok: false, reason: "audio_context_not_running" };
    if (!cue?.phrase) return { ok: false, reason: "missing_phrase" };
    const age = Date.now() - Number(cue.atMs || Date.now());
    if (age > freshnessMs) return { ok: false, reason: "cue_expired", ageMs: age };
    const clip = decodedRef.current.get(`${cue.type}:${cue.phrase}`);
    if (!clip?.audioBuffer) return { ok: false, reason: "clip_not_preloaded" };

    if (Number(settings?.volume ?? 0.28) === 0) return { ok: false, reason: "muted" };
    const startedAt = performance.now();
    try {
      activeSourceRef.current?.stop?.();
    } catch {}

    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = clip.audioBuffer;
    const volume = Math.max(0, Math.min(1, Number(settings?.volume ?? 0.28)));
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.05);
    gain.gain.setValueAtTime(volume, now + Math.max(0.05, clip.audioBuffer.duration - 0.12));
    gain.gain.linearRampToValueAtTime(0.0001, now + clip.audioBuffer.duration);
    source.connect(gain);
    gain.connect(ctx.destination);
    activeSourceRef.current = source;
    source.start(now + 0.02);
    speaking = { owner: ownerRef.current, source };
    source.onended = () => {
      if (speaking?.source === source) speaking = null;
      try { source.disconnect(); gain.disconnect(); } catch {}
      if (activeSourceRef.current === source) activeSourceRef.current = null;
    };
    return {
      ok: true,
      scheduledAt: performance.now(),
      dispatchLatencyMs: Math.round(performance.now() - startedAt),
      estimatedFirstFrameMs: Math.round(performance.now() - startedAt + 20),
    };
  }, [enabled, settings?.volume]);

  const speakGenerated = useCallback(async (cue,{context,captureKind,recent,style,canPlay=()=>true}={})=>{
    const generation=generationRef.current;
    try {
      if(!enabled||!canPlay())return {ok:false,reason:'cancelled'};
      const response=await fetch(apiUrl('/live-cues/generate'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:cue.type,context,captureKind,recent,style}),signal:AbortSignal.timeout(8000)});
      const payload=await response.json();if(!response.ok)throw Error(payload.error||'Generated feedback unavailable.');
      const phrase=payload.text;if(!phrase)return {ok:false,reason:'nothing_new'};
      if(generation!==generationRef.current||!canPlay())return {ok:false,reason:'cancelled'};
      const generated={...cue,phrase};
      const audioResponse=await fetch(apiUrl('/live-cues/prepare'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clips:[{type:cue.type,text:phrase}],...settings,ttsProvider:settings?.ttsProvider||loadTTSSettings().ttsProvider}),signal:AbortSignal.timeout(15000)});
      const prepared=await audioResponse.json();if(!audioResponse.ok||!prepared.clips?.[0])throw Error(prepared.error||'Generated voice audio unavailable.');
      const decoded=await decodeClip(getAudioContext(),prepared.clips[0]);
      if(generation!==generationRef.current||!canPlay()||Date.now()-cue.atMs>15000)return {ok:false,reason:'cue_expired',phrase};
      decodedRef.current.set(`${cue.type}:${phrase}`,decoded);
      while(decodedRef.current.size>64)decodedRef.current.delete(decodedRef.current.keys().next().value);
      return {...playCue(generated,{freshnessMs:15000}),phrase,generated:true};
    }catch(error){setStatus(previous=>({...previous,phase:'error',message:error.message}));return {ok:false,reason:'generation_failed',error:error.message};}
  },[enabled,getAudioContext,playCue,settings]);

  const stop = useCallback(() => {
    try {
      activeSourceRef.current?.stop?.();
    } catch {}
    activeSourceRef.current = null;
    if (speaking?.owner === ownerRef.current) speaking = null;
  }, []);

  useEffect(() => {
    if (!enabled) stop();
    generationRef.current += 1;
    prepareRef.current = null;
    decodedRef.current = new Map();
    setStatus({ phase: enabled ? "idle" : "disabled", message: enabled ? "Sarah encouragement is ready to prepare." : "Sarah encouragement disabled.", decoded: 0, total: 0 });
  }, [enabled, phraseSignature, settings?.format, settings?.model, settings?.speed, settings?.voice, settings?.ttsProvider, stop]);

  useEffect(() => () => {
    generationRef.current += 1;
    stop();
    const ctx = audioContextRef.current;
    if (ctx) {
      ctx.onstatechange = null;
      ctx.close().catch(() => {});
    }
  }, [stop]);

  const testVoice = useCallback(async () => {
    await unlock();
    if (!decodedRef.current.size) await prepare();
    const clip = decodedRef.current.values().next().value;
    if (!clip) throw new Error("No encouragement audio is ready. Retry Test voice.");
    return playCue({ type: clip.type, phrase: clip.text, atMs: Date.now() });
  }, [unlock, prepare, playCue]);

  const ready = status.phase === "ready";
  const decodedCount = status.decoded;

  return useMemo(() => ({
    status,
    audioState,
    testVoice,
    unlock,
    prepare,
    playCue,
    speakGenerated,
    stop,
    ready: status.phase === "ready",
    decodedCount: status.decoded,
  }), [audioState, testVoice, decodedCount, prepare, playCue, speakGenerated, ready, status, stop, unlock]);
}
