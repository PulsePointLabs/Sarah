import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Brain, Activity, AlertCircle, Zap, TrendingUp, Heart, Lightbulb, User, ChevronDown, ChevronUp } from "lucide-react";
import TTSReader from "../components/TTSReader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

// ── helpers ────────────────────────────────────────────────────────────────────

function fmtSec(s) {
  if (s == null) return "—";
  const v = Math.round(Math.abs(s));
  return v >= 60 ? `${Math.floor(v / 60)}m${v % 60}s` : `${v}s`;
}

// Import-equivalent: NCE keyword list for note corroboration (mirrored from NearClimaxEvents)
const NCE_KEYWORDS = [
  "tension", "tense", "tight", "tighten", "clench", "grip",
  "foot", "feet", "plant", "planting", "toe", "curl",
  "throb", "pulse", "pulsing", "twitch", "spasm",
  "edge", "edg", "near", "almost", "close", "threshold",
  "pressure", "build", "buildup", "surge", "wave", "rush",
  "intense", "intensity", "strong", "overwhelming",
  "breath", "breathing", "gasp", "hold",
  "shiver", "shak", "tremble",
];

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
    if (cats.some(c => ["physical", "sensation"].includes(c))) score += 1 * proximityWeight;
    for (const kw of NCE_KEYWORDS) {
      if (note.includes(kw)) { score += 2 * proximityWeight; break; }
    }
  }
  return score;
}

// Detect near-climax events: sustained HR elevations (not brief spikes) before the pre-climax marker.
// Uses event note corroboration for confidence scoring.
function detectNearClimaxEvents(rows, climaxOffsetS, preClimaxOffsetS, sessionEvents = []) {
  if (!rows || rows.length < 10) return [];

  const smoothed = rows.map((r, i) => {
    const win = rows.slice(Math.max(0, i - 3), i + 4);
    const avg = win.reduce((a, w) => a + Number(w.hr), 0) / win.length;
    return { t: Number(r.time_offset_s), hr: avg };
  });

  const excludeStart = climaxOffsetS != null
    ? (preClimaxOffsetS != null
        ? Math.min(preClimaxOffsetS, climaxOffsetS - 60)
        : climaxOffsetS - 90)
    : Infinity;

  const allHRs = smoothed.filter(p => p.t < excludeStart).map(p => p.hr);
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
    if (t0 < lastEventEnd + COOLDOWN_S) { i++; continue; }
    if (t0 >= excludeStart) break;

    let peakIdx = i;
    let peakHr = hr0;
    for (let j = i + 1; j < smoothed.length; j++) {
      if (smoothed[j].t - t0 > RISE_WINDOW_S) break;
      if (smoothed[j].t >= excludeStart) break;
      if (smoothed[j].hr > peakHr) { peakHr = smoothed[j].hr; peakIdx = j; }
    }

    const rise = peakHr - hr0;
    if (rise < MIN_RISE_BPM || rise > MAX_RISE_BPM || peakIdx === i) { i++; continue; }

    const peakTime = smoothed[peakIdx].t;

    // Require sustained elevation — not just a momentary spike
    let sustainedEndIdx = peakIdx;
    for (let j = peakIdx + 1; j < smoothed.length; j++) {
      if (smoothed[j].t - peakTime > 90) break;
      if (smoothed[j].hr >= peakHr - SUSTAINED_TOLERANCE) sustainedEndIdx = j;
    }
    const sustainedDuration = smoothed[sustainedEndIdx].t - peakTime;
    if (sustainedDuration < SUSTAINED_THRESHOLD_S) { i = peakIdx + 1; continue; }

    let dropIdx = -1;
    for (let j = sustainedEndIdx + 1; j < smoothed.length; j++) {
      if (smoothed[j].t - peakTime > SEARCH_DROP_S) break;
      if (smoothed[j].hr <= peakHr - DROP_BPM) { dropIdx = j; break; }
    }
    if (dropIdx === -1) { i = peakIdx + 1; continue; }

    const eventDuration = smoothed[dropIdx].t - t0;
    if (eventDuration < MIN_DURATION_S || eventDuration > MAX_DURATION_S) { i++; continue; }
    if (peakHr >= sessionMaxHR * 0.96) { i = dropIdx + 1; continue; }

    const noteScore = scoreEventNoteCorroboration(t0, smoothed[dropIdx].t, sessionEvents);
    const hrConfidence = Math.min(4, Math.floor((rise / MIN_RISE_BPM - 1) * 2) + Math.floor(sustainedDuration / 20));
    const totalConfidence = hrConfidence + noteScore;
    if (totalConfidence < MIN_CONFIDENCE) { i++; continue; }

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
      note_corroborated: noteScore > 0,
    });

    lastEventEnd = smoothed[dropIdx].t;
    i = dropIdx + 1;
  }

  return events;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SectionCard({ icon, title, color, children, defaultCollapsed = false }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <button
        className="w-full flex items-center justify-between gap-1.5 text-left"
        onClick={() => setCollapsed(v => !v)}
      >
        <h3 className="text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color }}>
          {icon}{title}
        </h3>
        {collapsed
          ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
          : <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>
      {!collapsed && children}
    </div>
  );
}

function AIProfilePanel({ sessions, userProfile, journals }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    base44.entities.SessionClusterAnalysis.list("-updated_date", 1).then((rows) => {
      if (rows[0]?.result) setResult(rows[0].result);
    });
  }, []);

  const analyze = async () => {
    setLoading(true);
    setResult(null);

    const sessionSummaries = sessions.map((s) => ({
      date: s.date?.slice(0, 10),
      duration_minutes: s.duration_minutes,
      methods: s.methods,
      custom_methods: s.custom_methods,
      foley_size: s.foley_size,
      foley_type: s.foley_type,
      estim_notes: s.estim_notes,
      sleeve_type: s.sleeve_type,
      tens_placement: s.tens_placement,
      build_type: s.build_type,
      custom_build_type: s.custom_build_type,
      climax_duration: s.climax_duration,
      no_climax: s.no_climax,
      intensity: s.intensity,
      build_quality: s.build_quality,
      satisfaction: s.satisfaction,
      avg_hr: s.avg_hr,
      max_hr: s.max_hr,
      hr_at_climax: s.hr_at_climax,
      hr_avg_pre_to_climax: s.hr_avg_pre_to_climax,
      hr_avg_at_climax_window: s.hr_avg_at_climax_window,
      pre_climax_offset_s: s.pre_climax_offset_s,
      climax_offset_s: s.climax_offset_s,
      recovery_offset_s: s.recovery_offset_s,
      mood: s.mood,
      environment: s.environment,
      hydration: s.hydration,
      substances: s.substances,
      ejaculate_volume: s.ejaculate_volume,
      discomfort: s.discomfort,
      discomfort_entries: s.discomfort_entries?.length > 0 ? s.discomfort_entries : undefined,
      unusual_sensations: s.unusual_sensations,
      refractory_notes: s.refractory_notes,
      notes: s.notes,
      tags: s.tags,
      is_favorite: s.is_favorite,
      event_timeline: s.event_timeline?.length > 0 ? s.event_timeline.map(e => ({
        time_s: e.time_s,
        category: Array.isArray(e.category) ? e.category : [e.category].filter(Boolean),
        note: e.note,
      })) : undefined,
    }));

    const profileContext = userProfile ? `
USER PROFILE & NOTES:
Age: ${userProfile.age || "—"} | Fitness: ${userProfile.fitness_level || "—"} | Resting HR: ${userProfile.resting_hr || "—"} bpm | Max HR: ${userProfile.max_hr || "—"} bpm
Arousal style: ${userProfile.arousal_response_style || "—"} | Build duration: ${userProfile.typical_build_duration || "—"} | Climax sensitivity: ${userProfile.climax_sensitivity || "—"}
Preferred stimulation: ${(userProfile.preferred_stimulation || []).join(", ") || "—"}
Refractory pattern: ${userProfile.refractory_pattern || "—"}
Medications/conditions: ${userProfile.medications || "none noted"}
Arousal notes: ${userProfile.arousal_notes || "none"}
` : "";

    // Build journal context from all available journal entries
    const journalContext = (journals || []).length > 0 ? `

SESSION JOURNALS (${journals.length} entries — the person's own subjective post-session reflections, ordered most recent first):
${(journals || []).slice(0, 20).map((j, i) => {
  const ai = j.ai_journal;
  const date = j.session_date ? new Date(j.session_date).toISOString().slice(0, 10) : "unknown date";
  if (!ai && !j.voice_transcript) return null;
  return `[Session ${date}]:
${ai?.emotional_reflection ? `  Emotional: ${ai.emotional_reflection}` : ""}
${ai?.physiological_observations ? `  Physiological: ${ai.physiological_observations}` : ""}
${ai?.insights ? `  Insights: ${ai.insights}` : ""}
${ai?.next_session_intentions ? `  Intentions: ${ai.next_session_intentions}` : ""}
${j.voice_transcript && !ai ? `  Notes: ${j.voice_transcript}` : ""}`.trim();
}).filter(Boolean).join("\n\n")}

Use the journals to surface recurring emotional themes, evolving insights, and subjective experiences that the raw session metrics alone cannot reveal. Note where the person's own reflections align with or diverge from the physiological data.` : "";

    const res = await base44.integrations.Core.InvokeLLM({
      model: "claude_sonnet_4_6",
      prompt: `You are an expert physiological and sexual response analyst. Based on ${sessions.length} recorded sessions and profile notes, generate a comprehensive, deeply personal physiological and arousal profile. Write directly to the person — use "you" and "your" throughout, as if speaking to them personally.

CRITICAL FOR TEXT-TO-SPEECH QUALITY:
- Write all times as words: "ten minutes and thirty seconds" not "10:30"
- Spell out all numbers as words (e.g., "ten beats per minute" not "10 bpm")
- Write in conversational, sentence-based prose with natural pauses
- Use short sentences and simple grammar optimized for audio readability
- Avoid jargon—explain concepts clearly as if speaking aloud
- Use commas and periods to create natural speech cadence
${profileContext}${journalContext}
SESSION DATA (${sessions.length} sessions):
${JSON.stringify(sessionSummaries, null, 2)}

Generate a rich, holistic profile. Your job is NOT to restate what was already logged — the person already knows what they did. Instead, offer your own interpretations, inferences, hypotheses, and conclusions drawn FROM the data. Go beyond the surface. Make observations they may not have noticed themselves. Point out cross-session patterns, contradictions, and surprising findings. Be willing to form opinions and state them directly.

Cover these areas:

1. AROUSAL PHYSIOLOGY: Interpret the shape and character of their arousal response — don't just describe the HR numbers, explain what those patterns suggest about their autonomic nervous system, sympathetic drive, parasympathetic braking, and pelvic floor engagement. Comment on post-peak recovery slope, plateau behavior, and what their HR acceleration curves reveal about how their body builds and releases tension. Form a view on what type of physiological responder they are.

2. STIMULATION PROFILE: Don't list what methods they used — interpret what the outcomes reveal about their body's actual preferences. Which method combinations appear to produce synergistic effects vs. diminishing returns? What does the pattern of their best vs. worst sessions suggest about their sensitivity and saturation points?

3. CLIMAX & RECOVERY PATTERNS: Go beyond describing duration and volume — interpret what the pattern of their climax data reveals about their neuromuscular release profile, ejaculatory reflex threshold, and refractory physiology. What does the recovery slope tell you about their autonomic rebound?

4. CONTEXTUAL SENSITIVITIES: Form a hypothesis about which contextual factors matter MOST for this specific person based on cross-session correlation. Don't just list factors — rank them by apparent impact and explain why.

5. DISCOMFORT & PHYSIOLOGICAL EDGE CASES: Interpret what recurring discomfort or unusual sensations suggest anatomically — consider urethral, prostatic, pelvic floor, and neurovascular context given their specific methods. Hypothesize about tissue adaptation, nerve sensitization, or structural factors. Be specific, not generic.

6. BEHAVIORAL & AROUSAL TENDENCIES: Look for patterns in their build style, pause/resume habits, edging behavior, and event timelines that reveal something about their psychological relationship with arousal — control tendencies, anxiety responses, comfort zones. Offer a perspective on what those tendencies are likely doing to their outcomes.

7. PERSONAL OPTIMIZATION RECOMMENDATIONS: Give bold, specific, opinionated recommendations — not generic advice. Reference their actual data patterns and explain the physiological or behavioral reasoning behind each suggestion.

Be direct, insightful, and willing to state conclusions. Ground everything in their data but go well beyond restating it.`,
      response_json_schema: {
        type: "object",
        properties: {
          profile_overview: { type: "string" },
          arousal_physiology: { type: "array", items: { type: "string" } },
          stimulation_profile: { type: "array", items: { type: "string" } },
          climax_and_recovery: { type: "array", items: { type: "string" } },
          contextual_sensitivities: { type: "array", items: { type: "string" } },
          discomfort_and_edge_cases: { type: "array", items: { type: "string" } },
          behavioral_tendencies: { type: "array", items: { type: "string" } },
          optimization_recommendations: { type: "array", items: { type: "string" } },
        },
        required: ["profile_overview", "arousal_physiology", "stimulation_profile", "climax_and_recovery", "contextual_sensitivities", "behavioral_tendencies", "optimization_recommendations"],
      },
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    const parsed = raw?.response ?? raw;
    setResult(parsed);

    const existing = await base44.entities.SessionClusterAnalysis.list("-updated_date", 1);
    if (existing[0]) {
      await base44.entities.SessionClusterAnalysis.update(existing[0].id, { result: parsed, session_count: sessions.length });
    } else {
      await base44.entities.SessionClusterAnalysis.create({ result: parsed, session_count: sessions.length });
    }
    setLoading(false);
  };

  const SECTIONS = [
    { key: "arousal_physiology", label: "Arousal Physiology", icon: <Heart className="w-3.5 h-3.5" />, color: "hsl(var(--chart-3))" },
    { key: "stimulation_profile", label: "Stimulation Profile", icon: <Zap className="w-3.5 h-3.5" />, color: "hsl(var(--primary))" },
    { key: "climax_and_recovery", label: "Climax & Recovery", icon: <TrendingUp className="w-3.5 h-3.5" />, color: "hsl(var(--chart-2))" },
    { key: "contextual_sensitivities", label: "Contextual Sensitivities", icon: <Activity className="w-3.5 h-3.5" />, color: "hsl(var(--chart-4))" },
    { key: "discomfort_and_edge_cases", label: "Discomfort & Edge Cases", icon: <AlertCircle className="w-3.5 h-3.5" />, color: "hsl(var(--destructive))" },
    { key: "behavioral_tendencies", label: "Behavioral Tendencies", icon: <User className="w-3.5 h-3.5" />, color: "hsl(var(--accent))" },
    { key: "optimization_recommendations", label: "Optimization Recommendations", icon: <Lightbulb className="w-3.5 h-3.5" />, color: "hsl(var(--chart-1))" },
  ];

  // Build flat paragraph list for TTSReader
  const paras = [];
  const paraMeta = [];
  if (result) {
    if (result.profile_overview) { paras.push(result.profile_overview); paraMeta.push({ type: "overview" }); }
    for (const sec of SECTIONS) {
      for (const item of (result[sec.key] || [])) {
        paras.push(item);
        paraMeta.push({ type: "section", sec });
      }
    }
  }

  return (
    <SectionCard icon={<Brain className="w-4 h-4" />} title="Comprehensive Physiological Profile" color="hsl(var(--primary))" defaultCollapsed={true}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          AI-generated personal physiological & arousal profile based on all sessions, event timelines, and profile notes.
        </p>
        <Button size="sm" onClick={analyze} disabled={loading || sessions.length < 2} className="h-7 text-xs gap-1.5 shrink-0 ml-2">
          {loading
            ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Profiling…</>
            : <><Brain className="w-3 h-3" />{result ? "Re-generate" : "Generate Profile"}</>}
        </Button>
      </div>

      {sessions.length < 2 && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" /> Need at least 2 sessions to generate a profile.
        </p>
      )}

      {!result && !loading && sessions.length >= 2 && (
        <p className="text-xs text-muted-foreground">
          Click Generate Profile to create your comprehensive physiological and arousal profile. Uses Claude Sonnet.
        </p>
      )}

      {result && (
        <TTSReader
          sessionId="profiler_ai_profile"
          title="AI Physiological Profile"
          paragraphs={paras}
          renderParagraph={(text, idx, isActive) => {
            const meta = paraMeta[idx];
            if (!meta) return null;

            if (meta.type === "overview") {
              return (
                <p className={`text-base font-medium leading-relaxed border-l-2 pl-3 py-1 transition-all duration-200 rounded-r-md ${isActive ? "border-primary bg-primary/10 text-foreground" : "border-primary/50 text-foreground"}`}>
                  {text}
                </p>
              );
            }

            const { sec } = meta;
            // Check if first item in section → render section header
            const firstInSection = paras.findIndex((_, i) => paraMeta[i]?.type === "section" && paraMeta[i]?.sec?.key === sec.key) === idx;

            return (
              <div>
                {firstInSection && (
                  <p className="text-xs font-semibold flex items-center gap-1.5 mt-4 mb-1.5 pt-3 border-t border-border" style={{ color: sec.color }}>
                    {sec.icon}{sec.label}
                  </p>
                )}
                <li
                  className="text-sm pl-3 border-l-2 py-1 leading-relaxed list-none transition-all duration-200 rounded-r-md"
                  style={{
                    borderColor: isActive ? sec.color : sec.color + "55",
                    background: isActive ? sec.color + "18" : "transparent",
                    color: "hsl(var(--foreground))",
                  }}
                >
                  {text}
                </li>
              </div>
            );
          }}
        />
      )}
    </SectionCard>
  );
}

function NearClimaxPanel({ sessions, allTimelines }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [savedId, setSavedId] = useState(null);
  const [eventStats, setEventStats] = useState(null);

  useEffect(() => {
    base44.entities.SessionClusterAnalysis.list("-updated_date", 1).then((rows) => {
      if (rows[0]?.near_climax_result) {
        setResult(rows[0].near_climax_result);
        setSavedId(rows[0].id);
      }
    });
  }, []);

  const analyze = async () => {
    setLoading(true);
    setResult(null);

    // Detect events across all sessions with HR data
    const sessionEvents = [];
    for (const session of sessions) {
      const rows = allTimelines[session.id] || [];
      if (rows.length < 10) continue;
      const events = detectNearClimaxEvents(rows, session.climax_offset_s, session.pre_climax_offset_s, session.event_timeline || []);
      if (events.length > 0) {
        sessionEvents.push({
          date: session.date?.slice(0, 10),
          session_duration_s: Math.round(Math.max(...rows.map((r) => Number(r.time_offset_s)))),
          climax_offset_s: session.climax_offset_s,
          methods: session.methods,
          intensity: session.intensity,
          near_climax_events: events,
          event_count: events.length,
          total_time_in_events_s: Math.round(events.reduce((a, e) => a + e.duration_s, 0)),
          avg_rise_bpm: Math.round(events.reduce((a, e) => a + e.rise_bpm, 0) / events.length),
          max_peak_hr: Math.max(...events.map((e) => e.peak_hr))
        });
      }
    }

    const totalEvents = sessionEvents.reduce((a, s) => a + s.event_count, 0);
    const stats = {
      sessions_with_events: sessionEvents.length,
      total_events: totalEvents,
      avg_events_per_session: sessionEvents.length ? (totalEvents / sessionEvents.length).toFixed(1) : 0
    };
    setEventStats(stats);

    const res = await base44.integrations.Core.InvokeLLM({
      model: "claude_sonnet_4_6",
      prompt: `You are a physiological research assistant analyzing near-climax events detected in heart rate data from sexual response sessions. Write directly to the person — use "you" and "your" throughout, as if speaking to them personally.

CRITICAL FOR TEXT-TO-SPEECH QUALITY:
- Write all times as words: "ten minutes and thirty seconds" not "10:30"
- Spell out all numbers as words (e.g., "ten beats per minute" not "10 bpm")
- Write in conversational, sentence-based prose with natural pauses
- Use short sentences and simple grammar optimized for audio readability

A "near-climax event" is defined as: an erratic yet somewhat sustained climb in heart rate (eight or more beats per minute rise within forty-five seconds), followed by a notable drop — similar in shape to the climax cascade (ever-increasing HR with an apex and fall) but not as sustained. These events occur outside of the actual climax window.

Detected event data across ${sessionEvents.length} sessions (out of ${sessions.length} total):
${JSON.stringify(sessionEvents, null, 2)}

Provide a rich, interpretive narrative analysis. Focus on:
1. What these events physiologically represent for you — are they arousal plateaus, mini-edging responses, parasympathetic interruptions, or something else?
2. How frequently they occur and what that suggests about your physiological response pattern.
3. Which session contexts (methods, duration, time-in-session) seem to trigger more of these events for you.
4. What role they likely play in your overall arousal arc — do they precede stronger or weaker climax events for you?
5. Recommendations for how you can leverage or manage these events to optimize your session outcomes.

Be interpretive, insightful, and speak directly to the person. Reference specific sessions where notable.`,
      response_json_schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          physiological_interpretation: { type: "string" },
          pattern_analysis: { type: "array", items: { type: "string" } },
          contextual_triggers: { type: "array", items: { type: "string" } },
          role_in_arousal_arc: { type: "string" },
          recommendations: { type: "array", items: { type: "string" } }
        },
        required: ["summary", "physiological_interpretation", "pattern_analysis", "contextual_triggers", "role_in_arousal_arc", "recommendations"]
      }
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    const parsed = raw?.response ?? raw;
    setResult(parsed);

    // Save to entity
    const existing = await base44.entities.SessionClusterAnalysis.list("-updated_date", 1);
    if (existing[0]) {
      await base44.entities.SessionClusterAnalysis.update(existing[0].id, { near_climax_result: { ...parsed, _stats: stats, _session_events: sessionEvents } });
      setSavedId(existing[0].id);
    } else {
      const created = await base44.entities.SessionClusterAnalysis.create({ near_climax_result: { ...parsed, _stats: stats, _session_events: sessionEvents } });
      setSavedId(created.id);
    }
    setLoading(false);
  };

  const savedStats = result?._stats;
  const savedSessionEvents = result?._session_events;
  const displayStats = eventStats || savedStats;
  const displaySessionEvents = savedSessionEvents;

  return (
    <SectionCard icon={<Zap className="w-4 h-4" />} title="Near-Climax Event Analysis" color="hsl(var(--chart-3))" defaultCollapsed={true}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Detects erratic HR spikes & reversals that resemble — but don't complete — a climax cascade.</p>
        <Button size="sm" onClick={analyze} disabled={loading} className="h-7 text-xs gap-1.5 shrink-0">
          {loading ?
            <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</> :
            <><Brain className="w-3 h-3" />{result ? "Re-run" : "Analyze"}</>}
        </Button>
      </div>

      {displayStats &&
      <div className="grid grid-cols-3 gap-2">
          {[
        ["Sessions w/ Events", displayStats.sessions_with_events],
        ["Total Events", displayStats.total_events],
        ["Avg per Session", displayStats.avg_events_per_session]].
        map(([l, v]) =>
        <div key={l} className="bg-muted/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold font-mono">{v}</p>
              <p className="text-[9px] text-muted-foreground">{l}</p>
            </div>
        )}
        </div>
      }

      {displaySessionEvents?.length > 0 &&
      <div className="space-y-1.5">
          <p className="text-[10px] text-muted-foreground uppercase font-semibold">Per Session</p>
          {displaySessionEvents.map((s, i) =>
        <div key={i} className="flex flex-wrap items-center gap-2 text-[10px]">
              <span className="font-mono text-muted-foreground w-14 shrink-0">{s.date}</span>
              <Badge variant="outline" className="text-[9px] h-4 px-1">{s.event_count} events</Badge>
              <Badge variant="outline" className="text-[9px] h-4 px-1">{fmtSec(s.total_time_in_events_s)} total</Badge>
              <Badge variant="outline" className="text-[9px] h-4 px-1">+{s.avg_rise_bpm} bpm avg rise</Badge>
            </div>
        )}
        </div>
      }

      {result && (() => {
        const SECTIONS = [
          { key: "physiological_interpretation", label: "Physiological Interpretation", single: true, color: "hsl(var(--chart-3))" },
          { key: "pattern_analysis", label: "Pattern Analysis", color: "hsl(var(--primary))" },
          { key: "contextual_triggers", label: "Contextual Triggers", color: "hsl(var(--chart-4))" },
          { key: "role_in_arousal_arc", label: "Role in Arousal Arc", single: true, color: "hsl(var(--chart-2))" },
          { key: "recommendations", label: "Recommendations", color: "hsl(var(--accent))" },
        ];

        const paras = [];
        const paraMeta = [];
        if (result.summary) { paras.push(result.summary); paraMeta.push({ type: "summary" }); }
        for (const sec of SECTIONS) {
          if (sec.single) {
            if (result[sec.key]) { paras.push(result[sec.key]); paraMeta.push({ type: "section", sec, first: true }); }
          } else {
            (result[sec.key] || []).forEach((item, itemIdx) => {
              paras.push(item);
              paraMeta.push({ type: "section", sec, first: itemIdx === 0 });
            });
          }
        }

        return (
          <TTSReader
            sessionId="profiler_near_climax"
            title="Near-Climax Event Analysis"
            paragraphs={paras}
            renderParagraph={(text, idx, isActive, isBuffering) => {
              const meta = paraMeta[idx];
              if (!meta) return null;
              if (meta.type === "summary") {
                return (
                  <p className={`text-base font-medium leading-relaxed border-l-2 pl-3 py-1 transition-all duration-200 rounded-r-md flex items-center gap-2 ${isActive ? "border-primary bg-primary/8 text-foreground" : "border-chart-3 text-foreground"}`}>
                    {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />}
                    {text}
                  </p>
                );
              }
              const { sec, first } = meta;
              return (
                <div>
                  {first && (
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-1.5 tracking-wider mt-3" style={{ color: sec.color }}>
                      {sec.label}
                    </p>
                  )}
                  <li
                    className="text-sm pl-3 border-l-2 py-1 leading-relaxed list-none transition-all duration-200 rounded-r-md flex items-center gap-2"
                    style={{
                      borderColor: isActive ? sec.color : sec.color + "55",
                      background: isActive ? sec.color + "18" : "transparent",
                      color: "hsl(var(--foreground))",
                    }}
                  >
                    {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: sec.color, borderTopColor: "transparent" }} />}
                    {text}
                  </li>
                </div>
              );
            }}
          />
        );
      })()}
    </SectionCard>);

}

function StimulationMethodsPanel({ sessions, userProfile }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    base44.entities.SessionClusterAnalysis.list("-updated_date", 1).then((rows) => {
      if (rows[0]?.stimulation_methods_result) setResult(rows[0].stimulation_methods_result);
    });
  }, []);

  const analyze = async () => {
    setLoading(true);
    setResult(null);

    // Build per-method aggregates
    const methodMap = {};
    for (const s of sessions) {
      const methods = [...(s.methods || []), ...(s.custom_methods || [])];
      for (const m of methods) {
        if (!methodMap[m]) methodMap[m] = [];
        methodMap[m].push({
          date: s.date?.slice(0, 10),
          intensity: s.intensity,
          satisfaction: s.satisfaction,
          build_quality: s.build_quality,
          build_type: s.build_type,
          climax_duration: s.climax_duration,
          no_climax: s.no_climax || false,
          avg_hr: s.avg_hr,
          max_hr: s.max_hr,
          hr_at_climax: s.hr_at_climax,
          hr_avg_pre_to_climax: s.hr_avg_pre_to_climax,
          pre_climax_offset_s: s.pre_climax_offset_s,
          climax_offset_s: s.climax_offset_s,
          recovery_offset_s: s.recovery_offset_s,
          ejaculate_volume: s.ejaculate_volume,
          discomfort_entries: s.discomfort_entries?.length ? s.discomfort_entries : undefined,
          unusual_sensations: s.unusual_sensations || undefined,
          mood: s.mood,
          hydration: s.hydration,
          duration_minutes: s.duration_minutes,
          foley_size: s.foley_size || undefined,
          foley_type: s.foley_type || undefined,
          estim_notes: s.estim_notes || undefined,
          sleeve_type: s.sleeve_type || undefined,
          other_methods_used: methods.filter(x => x !== m),
          event_highlights: s.event_timeline?.length
            ? s.event_timeline.slice(0, 8).map(e => ({ time_s: e.time_s, category: Array.isArray(e.category) ? e.category : [e.category].filter(Boolean), note: e.note }))
            : undefined,
          notes: s.notes || undefined,
        });
      }
    }

    // Compute quick stats per method
    const methodStats = Object.entries(methodMap).map(([method, sessionList]) => {
      const withClimax = sessionList.filter(s => !s.no_climax);
      const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 : null;
      return {
        method,
        session_count: sessionList.length,
        climax_rate_pct: sessionList.length ? Math.round((withClimax.length / sessionList.length) * 100) : 0,
        avg_intensity: avg(sessionList.map(s => s.intensity).filter(Boolean)),
        avg_satisfaction: avg(sessionList.map(s => s.satisfaction).filter(Boolean)),
        avg_build_quality: avg(sessionList.map(s => s.build_quality).filter(Boolean)),
        avg_max_hr: avg(sessionList.map(s => s.max_hr).filter(Boolean)),
        avg_hr_at_climax: avg(withClimax.map(s => s.hr_at_climax).filter(Boolean)),
        discomfort_rate_pct: Math.round((sessionList.filter(s => s.discomfort_entries?.length).length / sessionList.length) * 100),
        common_combos: [...new Set(sessionList.flatMap(s => s.other_methods_used))].slice(0, 5),
        sessions: sessionList,
      };
    }).sort((a, b) => b.session_count - a.session_count);

    const profileContext = userProfile ? `USER PROFILE: Arousal style: ${userProfile.arousal_response_style || "—"} | Preferred stimulation: ${(userProfile.preferred_stimulation || []).join(", ") || "—"} | Climax sensitivity: ${userProfile.climax_sensitivity || "—"} | Arousal notes: ${userProfile.arousal_notes || "none"}` : "";

    const res = await base44.integrations.Core.InvokeLLM({
      model: "claude_sonnet_4_6",
      prompt: `You are a physiological research analyst specializing in sexual response and stimulation science. Analyze how different stimulation methods affect this person's sensations and physiology based on their session data. Write directly to the person — use "you" and "your" throughout.

CRITICAL FOR TEXT-TO-SPEECH QUALITY:
- Write all times as words: "ten minutes" not "10m"
- Spell out all numbers as words (e.g., "eight out of ten" not "8/10", "seventy-two beats per minute" not "72 bpm")
- Write in conversational prose with natural pauses — no bullet points or markdown
- Short sentences optimized for audio readability
${profileContext}

METHOD PERFORMANCE DATA (${sessions.length} sessions across ${methodStats.length} methods):
${JSON.stringify(methodStats.map(m => ({ ...m, sessions: undefined, method: m.method, session_count: m.session_count, climax_rate_pct: m.climax_rate_pct, avg_intensity: m.avg_intensity, avg_satisfaction: m.avg_satisfaction, avg_build_quality: m.avg_build_quality, avg_max_hr: m.avg_max_hr, avg_hr_at_climax: m.avg_hr_at_climax, discomfort_rate_pct: m.discomfort_rate_pct, common_combos: m.common_combos })), null, 2)}

FULL SESSION DATA PER METHOD (for deep analysis):
${JSON.stringify(methodStats.map(m => ({ method: m.method, sessions: m.sessions })), null, 2)}

Provide a deep, interpretive analysis. Do NOT simply restate the numbers — interpret what they reveal about this person's physiology, nerve response, and arousal dynamics. Be direct, opinionated, and specific.

Cover these areas:
1. METHOD EFFECTIVENESS PROFILE: For each method with meaningful data, form a clear opinion on its role — primary driver, arousal amplifier, or plateau extender? Rank them by their apparent physiological impact, not just by session count.
2. PHYSIOLOGICAL EFFECTS BY METHOD: How does each method seem to engage different physiological pathways? Reference HR patterns, build quality, and climax metrics. Which methods drive the strongest autonomic activation? Which tend toward sensory saturation?
3. COMBINATION EFFECTS: What method combinations appear in the best sessions vs. worst? Are there synergistic pairings you can identify from the data? Are any combinations associated with discomfort or diminishing returns?
4. AROUSAL & CLIMAX FINDINGS: Across all methods, what patterns emerge about how this person's body responds? Note anything surprising — unexpected correlations, methods that seem to punch above their weight, or methods associated with no-climax sessions.
5. DISCOMFORT & SENSITIVITY PATTERNS: Which methods correlate with discomfort entries and unusual sensations? What does this suggest about tissue sensitivity, nerve thresholds, or technique factors?
6. PERSONALIZED RECOMMENDATIONS: Give specific, actionable suggestions based on this exact data. Be bold and direct.

Each section should be 2-4 sentences of flowing, TTS-ready prose.`,
      response_json_schema: {
        type: "object",
        properties: {
          overview: { type: "string" },
          method_effectiveness: { type: "array", items: { type: "string" } },
          physiological_effects: { type: "array", items: { type: "string" } },
          combination_effects: { type: "array", items: { type: "string" } },
          arousal_and_climax_findings: { type: "array", items: { type: "string" } },
          discomfort_and_sensitivity: { type: "array", items: { type: "string" } },
          recommendations: { type: "array", items: { type: "string" } },
        },
        required: ["overview", "method_effectiveness", "physiological_effects", "combination_effects", "arousal_and_climax_findings", "recommendations"],
      },
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    const parsed = { ...raw?.response ?? raw, _method_stats: methodStats.map(m => ({ method: m.method, session_count: m.session_count, climax_rate_pct: m.climax_rate_pct, avg_satisfaction: m.avg_satisfaction, avg_intensity: m.avg_intensity, discomfort_rate_pct: m.discomfort_rate_pct })) };
    setResult(parsed);

    const existing = await base44.entities.SessionClusterAnalysis.list("-updated_date", 1);
    if (existing[0]) {
      await base44.entities.SessionClusterAnalysis.update(existing[0].id, { stimulation_methods_result: parsed });
    } else {
      await base44.entities.SessionClusterAnalysis.create({ stimulation_methods_result: parsed });
    }
    setLoading(false);
  };

  const SECTIONS = [
    { key: "method_effectiveness", label: "Method Effectiveness", color: "hsl(var(--primary))" },
    { key: "physiological_effects", label: "Physiological Effects", color: "hsl(var(--chart-3))" },
    { key: "combination_effects", label: "Combination Effects", color: "hsl(var(--chart-2))" },
    { key: "arousal_and_climax_findings", label: "Arousal & Climax Findings", color: "hsl(var(--chart-4))" },
    { key: "discomfort_and_sensitivity", label: "Discomfort & Sensitivity", color: "hsl(var(--destructive))" },
    { key: "recommendations", label: "Recommendations", color: "hsl(var(--accent))" },
  ];

  const methodStats = result?._method_stats || [];

  const paras = [];
  const paraMeta = [];
  if (result) {
    if (result.overview) { paras.push(result.overview); paraMeta.push({ type: "overview" }); }
    for (const sec of SECTIONS) {
      (result[sec.key] || []).forEach((item, itemIdx) => {
        paras.push(item);
        paraMeta.push({ type: "section", sec, first: itemIdx === 0 });
      });
    }
  }

  return (
    <SectionCard icon={<Zap className="w-4 h-4" />} title="Stimulation Methods Analysis" color="hsl(var(--primary))" defaultCollapsed={true}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          How each stimulation method affects your physiology, arousal, and climax outcomes across sessions.
        </p>
        <Button size="sm" onClick={analyze} disabled={loading || sessions.length < 2} className="h-7 text-xs gap-1.5 shrink-0 ml-2">
          {loading
            ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</>
            : <><Brain className="w-3 h-3" />{result ? "Re-generate" : "Analyze Methods"}</>}
        </Button>
      </div>

      {sessions.length < 2 && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" /> Need at least 2 sessions to analyze.
        </p>
      )}

      {/* Method stats grid */}
      {methodStats.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Method Overview</p>
          <div className="grid gap-2">
            {methodStats.map((m) => (
              <div key={m.method} className="flex flex-wrap items-center gap-2 bg-muted/40 rounded-lg px-3 py-2">
                <span className="text-xs font-semibold text-foreground min-w-[120px]">{m.method}</span>
                <Badge variant="outline" className="text-[9px] h-4 px-1">{m.session_count} sessions</Badge>
                <Badge variant="outline" className="text-[9px] h-4 px-1">{m.climax_rate_pct}% climax</Badge>
                {m.avg_satisfaction != null && <Badge variant="outline" className="text-[9px] h-4 px-1">sat {m.avg_satisfaction}/10</Badge>}
                {m.avg_intensity != null && <Badge variant="outline" className="text-[9px] h-4 px-1">int {m.avg_intensity}/10</Badge>}
                {m.discomfort_rate_pct > 0 && <Badge variant="outline" className="text-[9px] h-4 px-1 text-destructive border-destructive/40">{m.discomfort_rate_pct}% discomfort</Badge>}
              </div>
            ))}
          </div>
        </div>
      )}

      {!result && !loading && sessions.length >= 2 && (
        <p className="text-xs text-muted-foreground">Click Analyze Methods to generate a deep physiological interpretation of each stimulation method. Uses Claude Sonnet.</p>
      )}

      {result && (
        <TTSReader
          sessionId="profiler_stim_methods"
          title="Stimulation Methods Analysis"
          paragraphs={paras}
          renderParagraph={(text, idx, isActive, isBuffering) => {
            const meta = paraMeta[idx];
            if (!meta) return null;
            if (meta.type === "overview") {
              return (
                <p className={`text-base font-medium leading-relaxed border-l-2 pl-3 py-1 transition-all duration-200 rounded-r-md flex items-center gap-2 ${isActive ? "border-primary bg-primary/10 text-foreground" : "border-primary/50 text-foreground"}`}>
                  {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />}
                  {text}
                </p>
              );
            }
            const { sec, first } = meta;
            return (
              <div>
                {first && (
                  <p className="text-[10px] font-semibold uppercase tracking-wider mt-4 mb-1.5 pt-3 border-t border-border" style={{ color: sec.color }}>
                    {sec.label}
                  </p>
                )}
                <li
                  className="text-sm pl-3 border-l-2 py-1 leading-relaxed list-none transition-all duration-200 rounded-r-md flex items-center gap-2"
                  style={{
                    borderColor: isActive ? sec.color : sec.color + "55",
                    background: isActive ? sec.color + "18" : "transparent",
                    color: "hsl(var(--foreground))",
                  }}
                >
                  {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: sec.color, borderTopColor: "transparent" }} />}
                  {text}
                </li>
              </div>
            );
          }}
        />
      )}
    </SectionCard>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function Profiler() {
  const [sessions, setSessions] = useState([]);
  const [allTimelines, setAllTimelines] = useState({});
  const [userProfile, setUserProfile] = useState(null);
  const [journals, setJournals] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [all, me, journalRows] = await Promise.all([
        base44.entities.Session.list("-date", 300),
        base44.auth.me(),
        base44.entities.Journal.list("-session_date", 300),
      ]);
      setSessions(all);
      setUserProfile(me);
      setJournals(journalRows);

      // Load HR timelines in small batches to avoid rate limits
      const withData = all.filter((s) => s.climax_offset_s != null || s.avg_hr != null);
      const BATCH = 5;
      const pairs = [];
      for (let i = 0; i < withData.length; i += BATCH) {
        const chunk = withData.slice(i, i + BATCH);
        const results = await Promise.all(
          chunk.map((s) =>
            base44.entities.HeartRateTimeline.filter({ session: s.id }, "time_offset_s", 5000).then((rows) => [s.id, rows])
          )
        );
        pairs.push(...results);
      }
      const map = {};
      pairs.forEach(([id, rows]) => {if (rows.length > 0) map[id] = rows;});
      setAllTimelines(map);
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="px-4 py-6 pb-24 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">AI Profiler</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{sessions.length} sessions · {Object.keys(allTimelines).length} with HR data</p>
      </div>

      <AIProfilePanel sessions={sessions} userProfile={userProfile} journals={journals} />
      <StimulationMethodsPanel sessions={sessions} userProfile={userProfile} />
      <NearClimaxPanel sessions={sessions} allTimelines={allTimelines} />
    </div>
  );
}