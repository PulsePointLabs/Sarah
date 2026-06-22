import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl, serverUrl } from "@/lib/mobileApiBase";
import { LIVE_CUE_PROFILE_VERSION } from "@/lib/liveCuePhrases";

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
  const response = await fetch(clipUrl, { cache: "force-cache" });
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
  const decodedRef = useRef(new Map());
  const [status, setStatus] = useState({ phase: enabled ? "idle" : "disabled", message: "", decoded: 0, total: 0 });

  const getAudioContext = useCallback(async () => {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) throw new Error("Web Audio is unavailable in this browser.");
    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      audioContextRef.current = new AudioCtor();
      gainRef.current = audioContextRef.current.createGain();
      gainRef.current.gain.value = Math.max(0, Math.min(1, Number(settings?.volume ?? 0.28)));
      gainRef.current.connect(audioContextRef.current.destination);
    }
    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }
    return audioContextRef.current;
  }, [settings?.volume]);

  const unlock = useCallback(async () => {
    const ctx = await getAudioContext();
    const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gainRef.current);
    source.start();
    return ctx.state === "running";
  }, [getAudioContext]);

  const prepare = useCallback(async () => {
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
    const response = await fetch(apiUrl("/live-cues/prepare"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clips: requested,
        voice: settings?.voice || "nova",
        model: settings?.model || "tts-1-hd",
        speed: settings?.speed || 1,
        format: settings?.format || "mp3",
        profileVersion: LIVE_CUE_PROFILE_VERSION,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Sarah voice cues could not be prepared.");
    }
    const decoded = new Map();
    for (const prepared of payload.clips || []) {
      const source = requested.find((clip) => clip.text === prepared.text);
      const clip = await decodeClip(ctx, { ...source, ...prepared });
      decoded.set(`${clip.type}:${clip.text}`, clip);
      setStatus({ phase: "preparing", message: "Decoding Sarah voice cues...", decoded: decoded.size, total: requested.length });
    }
    decodedRef.current = decoded;
    setStatus({ phase: "ready", message: "Sarah voice cues preloaded.", decoded: decoded.size, total: requested.length });
    return { ok: true, decoded: decoded.size, total: requested.length };
  }, [enabled, getAudioContext, phrases, settings?.format, settings?.model, settings?.speed, settings?.voice]);

  const playCue = useCallback((cue, { freshnessMs = 2500 } = {}) => {
    const ctx = audioContextRef.current;
    if (!ctx || ctx.state !== "running") return { ok: false, reason: "audio_context_not_running" };
    if (!cue?.phrase) return { ok: false, reason: "missing_phrase" };
    const age = Date.now() - Number(cue.atMs || Date.now());
    if (age > freshnessMs) return { ok: false, reason: "cue_expired", ageMs: age };
    const clip = decodedRef.current.get(`${cue.type}:${cue.phrase}`);
    if (!clip?.audioBuffer) return { ok: false, reason: "clip_not_preloaded" };

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
    source.onended = () => {
      try { source.disconnect(); gain.disconnect(); } catch {}
      if (activeSourceRef.current === source) activeSourceRef.current = null;
    };
    return {
      ok: true,
      scheduledAt: performance.now(),
      dispatchLatencyMs: Math.round(performance.now() - startedAt),
      estimatedFirstFrameMs: Math.round(performance.now() - startedAt + 20),
    };
  }, [settings?.volume]);

  const stop = useCallback(() => {
    try {
      activeSourceRef.current?.stop?.();
    } catch {}
    activeSourceRef.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const ready = status.phase === "ready";
  const decodedCount = status.decoded;

  return useMemo(() => ({
    status,
    unlock,
    prepare,
    playCue,
    stop,
    ready: status.phase === "ready",
    decodedCount: status.decoded,
  }), [decodedCount, prepare, playCue, ready, status, stop, unlock]);
}
