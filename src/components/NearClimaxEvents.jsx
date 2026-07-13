import { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { Zap, Sparkles, ChevronLeft, ChevronRight, Volume2, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { buildAIGroundingContext } from "@/lib/aiGrounding";
import { buildSessionVisualEvidenceDigest } from "@/lib/visualEvidence";
import { buildSessionMomentTelemetry } from "@/utils/sessionMomentTelemetry";
import { cleanTextForSpeech, getTTSMime, getTTSRuntime, prepareTTSInput } from "@/components/TTSButton";

function fmtSec(s) {
  if (s == null) return "—";
  const v = Math.round(Math.abs(s));
  if (v < 60) return `${v} second${v === 1 ? "" : "s"}`;
  const minutes = Math.floor(v / 60);
  const seconds = v % 60;
  return seconds > 0
    ? `${minutes} minute${minutes === 1 ? "" : "s"} and ${seconds} second${seconds === 1 ? "" : "s"}`
    : `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function fmtMmSs(s) {
  const totalS = Math.round(Number(s));
  const m = Math.floor(totalS / 60);
  const sec = totalS % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatTelemetryValue(value, unit = "", digits = 0) {
  const number = numberOrNull(value);
  if (number == null) return null;
  const rounded = digits > 0 ? number.toFixed(digits) : String(Math.round(number));
  return `${rounded}${unit}`;
}

function normalizeNarrativeText(text) {
  return String(text || "")
    .replace(/\s*([,.;:!?])/g, "$1")
    .replace(/([,.;:!?])(?=\S)/g, "$1 ")
    .replace(/\s*[–—]\s*/g, " — ")
    .replace(/\s{2,}/g, " ")
    .replace(/, —/g, " —")
    .replace(/\b(\d+)\s*(?:seconds?|s\b)/gi, (_, n) => {
      const v = parseInt(n, 10);
      if (v >= 60) {
        const m = Math.floor(v / 60);
        const s = v % 60;
        return s > 0 ? `${m} minutes and ${s} seconds` : `${m} minutes`;
      }
      return `${v} seconds`;
    })
    .replace(/\b(\d+)\s*(?:minutes?|min\b)/gi, (_, n) => {
      const v = parseInt(n, 10);
      return `${v} minute${v !== 1 ? "s" : ""}`;
    })
    .replace(/\b(\d+)\s*(?:bpm\b)/gi, (_, n) => `${n} beats per minute`)
    .trim();
}

function telemetryStripItems(packet) {
  const hrExact = packet?.heart_rate?.exact_window;
  const hrvExact = packet?.rr_hrv?.exact_window;
  const hrvContext = packet?.rr_hrv?.context_window;
  const quality = hrvExact?.quality_values?.[0] || hrvContext?.quality_values?.[0] || null;
  return [
    hrExact?.bpm_avg != null ? { label: "HR avg", value: formatTelemetryValue(hrExact.bpm_avg, " bpm") } : null,
    hrExact?.bpm_max != null ? { label: "HR peak", value: formatTelemetryValue(hrExact.bpm_max, " bpm") } : null,
    hrvExact?.rmssd_ms?.avg != null ? { label: "RMSSD", value: formatTelemetryValue(hrvExact.rmssd_ms.avg, " ms", 1) } : null,
    hrvExact?.sdnn_ms?.avg != null ? { label: "SDNN", value: formatTelemetryValue(hrvExact.sdnn_ms.avg, " ms", 1) } : null,
    hrvExact?.pnn50?.avg != null ? { label: "pNN50", value: formatTelemetryValue(hrvExact.pnn50.avg * 100, "%", 0) } : null,
    quality ? { label: "HRV quality", value: quality } : null,
  ].filter(Boolean);
}

function TelemetryStrip({ items = [] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={`${item.label}-${item.value}`}
          className="inline-flex items-center gap-1 rounded-full border border-current/10 bg-white/55 px-2 py-1 text-[10px] leading-none text-sky-700"
        >
          <span className="font-semibold uppercase tracking-wide opacity-80">{item.label}</span>
          <span className="font-mono text-slate-900">{item.value}</span>
        </span>
      ))}
    </div>
  );
}

function base64ToAudioBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer.slice(0);
}

async function fetchTTSBase64(text) {
  const runtime = getTTSRuntime();
  const format = runtime.format;
  const res = await base44.functions.invoke("openaiTTS", {
    text: prepareTTSInput(text),
    voice: "nova",
    model: runtime.model,
    speed: runtime.speed,
    instructions: runtime.supportsInstructions ? runtime.instructions : "",
    format,
  });
  return {
    audio: res?.data?.audio || "",
    mimeType: getTTSMime(format),
  };
}

// Keywords in event notes that corroborate a near-climax event
const NCE_KEYWORDS = [
"tension", "tense", "tight", "tighten", "clench", "grip",
"foot", "feet", "plant", "planting", "toe", "curl",
"throb", "pulse", "pulsing", "twitch", "spasm",
"edge", "edg", "near", "almost", "close", "threshold",
"pressure", "build", "buildup", "surge", "wave", "rush",
"intense", "intensity", "strong", "overwhelming",
"breath", "breathing", "gasp", "hold",
"shiver", "shak", "tremble"];


function scoreEventNoteCorroboration(eventStartS, eventEndS, sessionEvents) {
  if (!sessionEvents || sessionEvents.length === 0) return 0;
  const windowS = 45;
  let score = 0;
  for (const ev of sessionEvents) {
    const t = Number(ev.time_s);
    if (t < eventStartS - windowS || t > eventEndS + windowS) continue;
    const dist = Math.max(0, Math.min(Math.abs(t - eventStartS), Math.abs(t - eventEndS)));
    const proximityWeight = dist < 15 ? 2 : 1;
    const note = (ev.note || "").toLowerCase();
    const cats = Array.isArray(ev.category) ? ev.category : [ev.category].filter(Boolean);
    if (cats.some((c) => ["physical", "sensation"].includes(c))) score += 1 * proximityWeight;
    for (const kw of NCE_KEYWORDS) {
      if (note.includes(kw)) {score += 2 * proximityWeight;break;}
    }
  }
  return score;
}

export function detectNearClimaxEvents(rows, climaxOffsetS, preClimaxOffsetS, sessionEvents = []) {
  if (!rows || rows.length < 10) return [];

  const smoothed = rows.map((r, i) => {
    const win = rows.slice(Math.max(0, i - 3), i + 4);
    const avg = win.reduce((a, w) => a + Number(w.hr), 0) / win.length;
    return { t: Number(r.time_offset_s), hr: avg };
  });

  const excludeStart = climaxOffsetS != null ?
  preClimaxOffsetS != null ?
  Math.min(preClimaxOffsetS, climaxOffsetS - 60) :
  climaxOffsetS - 90 :
  Infinity;

  const allHRs = smoothed.filter((p) => p.t < excludeStart).map((p) => p.hr);
  if (allHRs.length < 10) return [];
  const sessionMinHR = Math.min(...allHRs);
  const sessionMaxHR = Math.max(...allHRs);
  const sessionHRRange = sessionMaxHR - sessionMinHR;

  const MIN_RISE_BPM = Math.max(7, sessionHRRange * 0.13);
  const MAX_RISE_BPM = sessionHRRange * 0.78;
  const RISE_WINDOW_S = 120;
  const SUSTAINED_THRESHOLD_S = 20;
  const SUSTAINED_TOLERANCE = 5;
  const DROP_BPM = Math.max(5, MIN_RISE_BPM * 0.55);
  const SEARCH_DROP_S = 150;
  const MIN_DURATION_S = 25;
  const MAX_DURATION_S = 300;
  const COOLDOWN_S = 30;
  const MIN_CONFIDENCE = 2;

  const events = [];
  let lastEventEnd = -Infinity;
  let i = 0;

  while (i < smoothed.length - 5) {
    const { t: t0, hr: hr0 } = smoothed[i];

    if (t0 < lastEventEnd + COOLDOWN_S) {i++;continue;}
    if (t0 >= excludeStart) break;

    let peakIdx = i;
    let peakHr = hr0;
    for (let j = i + 1; j < smoothed.length; j++) {
      if (smoothed[j].t - t0 > RISE_WINDOW_S) break;
      if (smoothed[j].t >= excludeStart) break;
      if (smoothed[j].hr > peakHr) {peakHr = smoothed[j].hr;peakIdx = j;}
    }

    const rise = peakHr - hr0;
    if (rise < MIN_RISE_BPM || rise > MAX_RISE_BPM || peakIdx === i) {i++;continue;}

    const peakTime = smoothed[peakIdx].t;

    let sustainedEndIdx = peakIdx;
    for (let j = peakIdx + 1; j < smoothed.length; j++) {
      if (smoothed[j].t - peakTime > 90) break;
      if (smoothed[j].hr >= peakHr - SUSTAINED_TOLERANCE) sustainedEndIdx = j;
    }
    const sustainedDuration = smoothed[sustainedEndIdx].t - peakTime;
    if (sustainedDuration < SUSTAINED_THRESHOLD_S) {i = peakIdx + 1;continue;}

    let dropIdx = -1;
    for (let j = sustainedEndIdx + 1; j < smoothed.length; j++) {
      if (smoothed[j].t - peakTime > SEARCH_DROP_S) break;
      if (smoothed[j].hr <= peakHr - DROP_BPM) {dropIdx = j;break;}
    }
    if (dropIdx === -1) {i = peakIdx + 1;continue;}

    const eventDuration = smoothed[dropIdx].t - t0;
    if (eventDuration < MIN_DURATION_S || eventDuration > MAX_DURATION_S) {i++;continue;}

    if (peakHr >= sessionMaxHR * 0.96) {i = dropIdx + 1;continue;}

    const noteScore = scoreEventNoteCorroboration(t0, smoothed[dropIdx].t, sessionEvents);
    const hrConfidence = Math.min(4, Math.floor((rise / MIN_RISE_BPM - 1) * 2) + Math.floor(sustainedDuration / 20));
    const totalConfidence = hrConfidence + noteScore;

    if (totalConfidence < MIN_CONFIDENCE) {i++;continue;}

    events.push({
      start_offset_s: t0,
      peak_offset_s: peakTime,
      end_offset_s: smoothed[dropIdx].t,
      base_hr: Math.round(hr0),
      peak_hr: Math.round(peakHr),
      rise_bpm: Math.round(rise),
      sustained_s: Math.round(sustainedDuration),
      duration_s: Math.round(eventDuration),
      confidence: Math.min(10, totalConfidence),
      note_corroborated: noteScore > 0
    });

    lastEventEnd = smoothed[dropIdx].t;
    i = dropIdx + 1;
  }

  return events;
}

// Sample HR data for the prompt — every ~10s to keep token count manageable
function sampleHRData(rows, targetPoints = 150) {
  if (!rows.length) return [];
  const step = Math.max(1, Math.floor(rows.length / targetPoints));
  return rows.
  filter((_, i) => i % step === 0).
  map((r) => ({ t: Math.round(Number(r.time_offset_s)), hr: Math.round(Number(r.hr)) }));
}

export default function NearClimaxEvents({ timelineRows, session, selectedIndex, onSelectIndex, onEventsRefined, userProfile }) {
  const algorithmicEvents = useMemo(
    () => detectNearClimaxEvents(timelineRows, session?.climax_offset_s, session?.pre_climax_offset_s, session?.event_timeline || []),
    [timelineRows, session]
  );

  // Prefer AI-refined events if available
  const aiEvents = session?.ai_near_climax_events;
  const hasAIEvents = aiEvents && aiEvents.length > 0;
  const events = hasAIEvents ? aiEvents : algorithmicEvents;
  const isAIRefined = hasAIEvents;

  const [refining, setRefining] = useState(false);
  const [speakingIndex, setSpeakingIndex] = useState(null);
  const [speechLoadingIndex, setSpeechLoadingIndex] = useState(null);
  const audioRef = useRef(null);
  const audioUrlRef = useRef("");

  const hasAIAnalysis = !!(session?.ai_analysis || session?.ai_cascade);
  const eventTelemetry = useMemo(() => (
    events.map((event) => buildSessionMomentTelemetry({
      session,
      timelineRows,
      startSeconds: Number(event.start_offset_s) || 0,
      endSeconds: Number(event.end_offset_s) || Number(event.start_offset_s) || 0,
      contextPadSeconds: 18,
    }))
  ), [events, session, timelineRows]);

  const stopSpeech = useCallback(() => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.src = "";
      } catch {}
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      try { URL.revokeObjectURL(audioUrlRef.current); } catch {}
      audioUrlRef.current = "";
    }
    setSpeakingIndex(null);
    setSpeechLoadingIndex(null);
  }, []);

  useEffect(() => () => stopSpeech(), [stopSpeech]);

  const refineWithAI = async () => {
    setRefining(true);

    const hrSample = sampleHRData(timelineRows, 200);
    const algoEvents = algorithmicEvents;

    // Build context from any existing AI analysis
    const existingAnalysis = session.ai_analysis ?
    [
    session.ai_analysis.summary,
    ...(session.ai_analysis.arousal_arc || []),
    ...(session.ai_analysis.event_analysis || [])].
    filter(Boolean).join(" ") :
    "";

    const cascadeContext = session.ai_cascade ?
    [
    session.ai_cascade.summary,
    ...(session.ai_cascade.build_phase || []),
    ...(session.ai_cascade.pre_climax_phase || [])].
    filter(Boolean).join(" ") :
    "";

    const userEvents = (session.event_timeline || []).map((e) => ({
      t: Math.round(e.time_s),
      note: e.note,
      category: Array.isArray(e.category) ? e.category : [e.category].filter(Boolean)
    }));

    const profileContext = userProfile && (userProfile.arousal_response_style || userProfile.arousal_notes || userProfile.climax_sensitivity || userProfile.arousal_notes)
      ? `- Arousal style: ${userProfile.arousal_response_style || "—"}\n- Typical build duration: ${userProfile.typical_build_duration || "—"}\n- Climax sensitivity: ${userProfile.climax_sensitivity || "—"}\n- Preferred stimulation: ${(userProfile.preferred_stimulation || []).join(", ") || "—"}\n- Arousal notes: ${userProfile.arousal_notes || "none"}`
      : "";
    const groundingContext = buildAIGroundingContext(userProfile);
    const reviewedVisualEvidence = buildSessionVisualEvidenceDigest(session);

    const res = await base44.integrations.Core.InvokeLLM({
      model: "claude_sonnet_4_6",
      prompt: `You are a physiological analyst reviewing heart rate data from a sexual arousal session. Your task is to identify and interpret "near-climax events" — sustained HR elevations (8+ bpm rise, held for at least 20 seconds, then resolved) that represent genuine arousal spikes in the build phase.

${groundingContext}
${reviewedVisualEvidence}

${profileContext ? `USER AROUSAL PROFILE (read this first — it defines how this person responds physiologically and shapes how you interpret every event):\n${profileContext}\n` : ""}
CRITICAL LABELING RULES — STRICTLY ENFORCED:
1. NEVER use the word "edging", "edge", "near-edge", or any edging-related language UNLESS a user event note explicitly uses those words to describe deliberate arousal control. A stimulation pause, HR drop, or high HR peak does NOT imply edging on its own.
2. HR patterns cannot confirm intent. A drop after a spike may be from stimulation change, physical fatigue, repositioning, technique switch, or natural arousal ebb — not deliberate control.
3. Labels must describe what the body is doing physiologically, not what the user intended. Examples of good labels: "Strong arousal surge", "Sustained arousal plateau", "Intensity response peak", "Rapid escalation phase", "Deep autonomic activation".
4. Interpretations must be grounded in: the HR pattern itself, nearby user-logged events, the user's arousal profile above, and the session context. Do not invent behavioral intent.
5. If the arousal profile describes a specific response style (e.g. rapid climber, plateau-heavy, involuntary spasms), use that to explain observed HR patterns instead of defaulting to behavioral assumptions.

SESSION CONTEXT:
- Duration: ${session.duration_minutes || "?"} minutes
- Climax marker: ${session.climax_offset_s != null ? Math.round(session.climax_offset_s) + "s" : "none"}
- Pre-climax marker: ${session.pre_climax_offset_s != null ? Math.round(session.pre_climax_offset_s) + "s" : "none"}
- Max HR: ${session.max_hr || "?"} bpm | Avg HR: ${session.avg_hr || "?"} bpm

${existingAnalysis ? `AI SESSION ANALYSIS (use this to identify arousal phases):\n${existingAnalysis.slice(0, 1500)}` : ""}

${cascadeContext ? `CASCADE ANALYSIS:\n${cascadeContext.slice(0, 800)}` : ""}

${userEvents.length > 0 ? `USER-LOGGED EVENTS:\n${userEvents.map((e) => `[${fmtSec(e.t)}] ${e.category.join(",")} — ${e.note}`).join("\n")}` : ""}

ALGORITHMICALLY DETECTED EVENTS (starting hints — refine or reject based on HR data and context):
${algoEvents.length > 0 ? JSON.stringify(algoEvents, null, 2) : "None detected algorithmically."}

HR DATA (time_s → bpm, sampled every ~${Math.max(1, Math.floor(timelineRows.length / 200))}s):
${hrSample.map((p) => `${p.t}:${p.hr}`).join("  ")}

Instructions:
1. Analyze the HR trace carefully. Identify rises of 8+ bpm that sustain for 20+ seconds before dropping.
2. Confirm, adjust, or reject algorithmic hints based on the full context. Add any events the algorithm missed.
3. Exclude the climax window (${session.pre_climax_offset_s != null ? Math.round(session.pre_climax_offset_s) : session.climax_offset_s != null ? Math.round(session.climax_offset_s) - 90 : "N/A"}s onward).
4. Be conservative — only include genuine arousal elevations, not noise or minor fluctuations.
5. Never write raw second offsets such as "at 943 seconds" or "943s". Use minutes and seconds.
6. For each event: provide a short label (3-5 words) describing the physiological response — never use "edging", "edge", or intent-based language. Then write a 1-2 sentence interpretation grounded in HR data, the user's arousal profile, and logged events. Use "you"/"your", spell out numbers as words, no abbreviations, no digits starting a sentence.

Return an array of near-climax events. If none exist, return an empty array.`,
      response_json_schema: {
        type: "object",
        properties: {
          events: {
            type: "array",
            items: {
              type: "object",
              properties: {
                start_offset_s: { type: "number" },
                peak_offset_s: { type: "number" },
                end_offset_s: { type: "number" },
                base_hr: { type: "number" },
                peak_hr: { type: "number" },
                rise_bpm: { type: "number" },
                sustained_s: { type: "number" },
                duration_s: { type: "number" },
                confidence: { type: "number" },
                note_corroborated: { type: "boolean" },
                ai_label: { type: "string" },
                ai_interpretation: { type: "string" }
              },
              required: ["start_offset_s", "peak_offset_s", "end_offset_s", "base_hr", "peak_hr", "rise_bpm", "ai_label", "ai_interpretation"]
            }
          },
          summary: { type: "string" }
        },
        required: ["events"]
      }
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    const parsed = raw?.response ?? raw;
    const refined = parsed.events || [];

    await base44.entities.Session.update(session.id, { ai_near_climax_events: refined });
    onEventsRefined?.(refined);
    setRefining(false);
  };

  const speakEventCard = useCallback(async (event, index) => {
    const telemetry = eventTelemetry[index];
    const stripItems = telemetryStripItems(telemetry);
    const spokenText = cleanTextForSpeech([
      event.ai_label ? `${event.ai_label}.` : `Near climax event ${index + 1}.`,
      `Starts at ${fmtMmSs(event.start_offset_s)} and lasts ${fmtSec(event.duration_s)}.`,
      `Heart rate rises from ${event.base_hr} to ${event.peak_hr} beats per minute.`,
      stripItems.length
        ? `Telemetry: ${stripItems.map((item) => `${item.label} ${item.value}`).join(", ")}.`
        : "",
      event.ai_interpretation ? normalizeNarrativeText(event.ai_interpretation) : "",
    ].filter(Boolean).join(" "));

    if (speakingIndex === index && audioRef.current) {
      stopSpeech();
      return;
    }

    stopSpeech();
    setSpeechLoadingIndex(index);
    try {
      const { audio, mimeType } = await fetchTTSBase64(spokenText);
      if (!audio) throw new Error("TTS returned no audio");
      const url = URL.createObjectURL(new Blob([base64ToAudioBytes(audio)], { type: mimeType }));
      const audioEl = new Audio(url);
      audioUrlRef.current = url;
      audioRef.current = audioEl;
      audioEl.preload = "auto";
      audioEl.onended = () => stopSpeech();
      audioEl.onerror = () => stopSpeech();
      setSpeakingIndex(index);
      setSpeechLoadingIndex(null);
      await audioEl.play();
    } catch (error) {
      console.error("Near-climax TTS failed:", error);
      stopSpeech();
    }
  }, [eventTelemetry, speakingIndex, stopSpeech]);

  const handleTap = useCallback((i) => {
    onSelectIndex?.(selectedIndex === i ? null : i);
    const event = events[i];
    if (event) speakEventCard(event, i);
  }, [events, onSelectIndex, selectedIndex, speakEventCard]);

  if (!timelineRows.length) return null;

  return (
    <div className="space-y-3 pt-1">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color: "hsl(var(--chart-3))" }}>
          <Zap className="w-3.5 h-3.5" /> Near-Climax Events
          {isAIRefined &&
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-accent/20 text-accent border border-accent/30">
              <Sparkles className="w-2.5 h-2.5" /> AI
            </span>
          }
        </h3>
        <Button
          size="sm"
          variant="ghost"
          disabled={refining}
          onClick={refineWithAI}
          className="h-6 text-[10px] gap-1 px-2 text-muted-foreground hover:text-accent"
          title={hasAIAnalysis ? "Re-run AI refinement using session analysis" : "Run AI refinement (run session AI analysis first for best results)"}>
          
          {refining ?
          <><span className="w-2.5 h-2.5 border-2 border-accent border-t-transparent rounded-full animate-spin" />Refining…</> :

          <><Sparkles className="w-2.5 h-2.5" />{isAIRefined ? "Re-refine" : "Refine with AI"}</>
          }
        </Button>
      </div>

      {!hasAIAnalysis && !isAIRefined &&
      <p className="text-[10px] text-muted-foreground italic">
          Run AI Session Analysis first for more accurate refinement.
        </p>
      }

      {events.length === 0 ?
      <p className="text-xs text-muted-foreground">
          No near-climax events detected{isAIRefined ? " (AI-verified)" : " in this session's HR data"}.
        </p> :

      <>
          <div className="grid grid-cols-3 gap-2">
            {[
          ["Detected", events.length],
          ["Total Time", fmtSec(events.reduce((a, e) => a + (e.duration_s || 0), 0))],
          ["Avg Rise", `+${Math.round(events.reduce((a, e) => a + (e.rise_bpm || 0), 0) / events.length)} bpm`]].
          map(([label, val]) =>
          <div key={label} className="bg-muted/50 rounded-lg p-2 text-center">
                <p className="text-lg font-bold font-mono">{val}</p>
                <p className="text-[9px] text-muted-foreground">{label}</p>
              </div>
          )}
          </div>

          <p className="text-[10px] text-muted-foreground italic">
            Tap an event to highlight it on the chart above and have Sarah read it aloud
          </p>

          {/* Event Navigator Bar — sits just above the event cards */}
          {(() => {
            const idx = selectedIndex ?? 0;
            const ev = events[idx];
            const telemetry = eventTelemetry[idx];
            const stripItems = telemetryStripItems(telemetry);
            const interpretation = normalizeNarrativeText(ev.ai_interpretation);
            return (
              <div className="rounded-xl border border-border bg-muted/40 px-3 py-3 flex flex-col gap-2">
                {/* Navigation buttons + label */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onSelectIndex?.(Math.max(0, idx - 1))}
                    disabled={idx === 0}
                    className="p-1 rounded-lg hover:bg-muted disabled:opacity-30 transition-colors shrink-0"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-xs font-bold font-mono truncate" style={{ color: "hsl(var(--chart-3))" }}>
                        {ev.ai_label ? ev.ai_label : `Event ${idx + 1}`}
                      </span>
                      <span className="text-[9px] text-muted-foreground shrink-0">{idx + 1} / {events.length}</span>
                    </div>
                    <div className="flex flex-wrap gap-2 mt-1">
                      <span className="text-[10px] font-mono text-muted-foreground">{fmtMmSs(ev.start_offset_s)} – {fmtMmSs(ev.end_offset_s)}</span>
                      <span className="text-[10px] text-muted-foreground">· <strong className="text-foreground font-mono">{fmtSec(ev.duration_s)}</strong></span>
                      <span className="text-[10px] text-muted-foreground"><strong className="text-foreground font-mono">{ev.base_hr}–{ev.peak_hr}</strong> bpm</span>
                      <span className="text-[10px] font-semibold" style={{ color: "hsl(var(--chart-3))" }}>↑ +{ev.rise_bpm} bpm</span>
                      {ev.note_corroborated && <span className="text-[9px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: "hsl(var(--chart-3) / 0.2)", color: "hsl(var(--chart-3))" }}>✓ corroborated</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => onSelectIndex?.(Math.min(events.length - 1, idx + 1))}
                    disabled={idx === events.length - 1}
                    className="p-1 rounded-lg hover:bg-muted disabled:opacity-30 transition-colors shrink-0"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
                <TelemetryStrip items={stripItems} />
                {/* Breakdown sentence */}
                {interpretation && (
                  <p className="text-sm leading-snug text-foreground/80 px-1">
                    {interpretation}
                  </p>
                )}
              </div>
            );
          })()}

          <div className="space-y-2">
            {events.map((ev, i) => {
            const isSelected = selectedIndex === i;
            const telemetry = eventTelemetry[i];
            const stripItems = telemetryStripItems(telemetry);
            const interpretation = normalizeNarrativeText(ev.ai_interpretation);
            const isSpeaking = speakingIndex === i;
            const isLoadingSpeech = speechLoadingIndex === i;
            return (
              <button
                key={i}
                onClick={() => handleTap(i)}
                className="w-full text-left rounded-lg px-3 py-2.5 space-y-1.5 transition-all"
                title={isSpeaking ? "Tap to stop Sarah" : "Tap to hear Sarah read this card"}
                style={{
                  background: isSelected ? "hsl(var(--chart-3) / 0.2)" : "hsl(var(--chart-3) / 0.08)",
                  borderLeft: `3px solid hsl(var(--chart-3) / ${isSelected ? "1" : "0.5"})`,
                  outline: isSelected ? "1.5px solid hsl(var(--chart-3) / 0.5)" : "none"
                }}>
                
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold font-mono" style={{ color: "hsl(var(--chart-3))" }}>
                      {ev.ai_label ? ev.ai_label : `Event ${i + 1}`} — {fmtMmSs(ev.start_offset_s)}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {(isLoadingSpeech || isSpeaking) && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[9px] font-semibold text-primary">
                          {isLoadingSpeech ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Volume2 className="h-2.5 w-2.5" />}
                          {isLoadingSpeech ? "Sarah loading" : "Sarah reading"}
                        </span>
                      )}
                      <Badge variant="outline" className="text-[9px] h-4 px-1.5">
                        {fmtSec(ev.duration_s)}
                      </Badge>
                    </div>
                  </div>
                  <TelemetryStrip items={stripItems} />
                  <div className="flex flex-wrap gap-2">
                    <span className="text-[10px] text-muted-foreground">
                      Base <strong className="text-foreground font-mono">{ev.base_hr}</strong> bpm
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      Peak <strong className="text-foreground font-mono">{ev.peak_hr}</strong> bpm
                    </span>
                    <span className="text-[10px]" style={{ color: "hsl(var(--chart-3))" }}>
                      ↑ +{ev.rise_bpm} bpm
                    </span>
                    {ev.sustained_s > 0 &&
                  <span className="text-[10px] text-muted-foreground">
                        Sustained <strong className="text-foreground font-mono">{fmtSec(ev.sustained_s)}</strong>
                      </span>
                  }
                    {ev.note_corroborated &&
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: "hsl(var(--chart-3) / 0.2)", color: "hsl(var(--chart-3))" }}>
                        ✓ corroborated
                      </span>
                  }
                  </div>
                  {interpretation && (
                  <p className="leading-snug mt-1 italic text-foreground/90 text-sm">
                    {interpretation}
                  </p>
                )}
                </button>);

          })}
          </div>
        </>
      }
    </div>);

}
