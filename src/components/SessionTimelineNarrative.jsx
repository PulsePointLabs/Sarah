import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { ChevronDown, ChevronUp, Activity, Clock, TrendingUp, Zap, Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";
import TTSReader from "./TTSReader";
import { EVENT_CATEGORIES } from "./session-form/EventTimelineSection";

function getCategoryMeta(value) {
  return EVENT_CATEGORIES.find((c) => c.value === value) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

const SECTION_DEFS = [
  { key: "timeline_narrative",   label: "Timeline Narrative",    color: "hsl(var(--chart-1))", icon: <Clock className="w-3.5 h-3.5" /> },
  { key: "hr_arc_commentary",    label: "HR Arc Commentary",     color: "hsl(var(--primary))", icon: <Activity className="w-3.5 h-3.5" /> },
  { key: "arousal_momentum",     label: "Arousal Momentum",      color: "hsl(var(--chart-2))", icon: <TrendingUp className="w-3.5 h-3.5" /> },
  { key: "turning_points",       label: "Turning Points",        color: "hsl(var(--chart-3))", icon: <Zap className="w-3.5 h-3.5" /> },
  { key: "what_worked",          label: "What Worked",           color: "hsl(var(--chart-4))", icon: <Lightbulb className="w-3.5 h-3.5" /> },
];

export default function SessionTimelineNarrative({ session, timelineRows, userProfile, sessionJournal }) {
  const [collapsed, setCollapsed] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(session.ai_timeline_narrative ?? null);

  const analyze = async () => {
    setLoading(true);
    setResult(null);

    const sortedRows = [...timelineRows].sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));

    const nearestHR = (time_s) => {
      if (!sortedRows.length) return null;
      let best = sortedRows[0];
      let bestDist = Math.abs(Number(sortedRows[0].time_offset_s) - time_s);
      for (const r of sortedRows) {
        const d = Math.abs(Number(r.time_offset_s) - time_s);
        if (d < bestDist) { bestDist = d; best = r; }
        if (Number(r.time_offset_s) > time_s + 15) break;
      }
      return Math.round(Number(best.hr));
    };

    const formatTime = (seconds) => {
      const m = Math.floor(seconds / 60);
      const s = Math.round(seconds % 60);
      if (m === 0) return `${s} second${s !== 1 ? "s" : ""}`;
      if (s === 0) return `${m} minute${m !== 1 ? "s" : ""}`;
      return `${m} minute${m !== 1 ? "s" : ""} and ${s} second${s !== 1 ? "s" : ""}`;
    };

    // Dense HR trajectory — up to 120 points for full-fidelity timeline
    const hrTrajectoryDense = (() => {
      if (!sortedRows.length) return null;
      const step = Math.max(1, Math.floor(sortedRows.length / 120));
      return sortedRows
        .filter((_, i) => i % step === 0)
        .map(r => `${Math.round(Number(r.time_offset_s))}s:${Math.round(Number(r.hr))}bpm`)
        .join("  ");
    })();

    // Rate of change between sampled points
    const hrGradients = (() => {
      if (!sortedRows.length) return null;
      const step = Math.max(1, Math.floor(sortedRows.length / 40));
      const sampled = sortedRows.filter((_, i) => i % step === 0);
      const out = [];
      for (let i = 1; i < sampled.length; i++) {
        const dt = Number(sampled[i].time_offset_s) - Number(sampled[i - 1].time_offset_s);
        const dhr = Number(sampled[i].hr) - Number(sampled[i - 1].hr);
        if (dt > 0) out.push(`${Math.round(Number(sampled[i].time_offset_s))}s:${(dhr / dt * 60).toFixed(1)}bpm/min`);
      }
      return out.join("  ");
    })();

    // Overall HR stats
    const hrStats = (() => {
      if (!sortedRows.length) return null;
      const allHR = sortedRows.map(r => Number(r.hr));
      const avg = Math.round(allHR.reduce((a, b) => a + b, 0) / allHR.length);
      const min = Math.round(Math.min(...allHR));
      const max = Math.round(Math.max(...allHR));
      const range = max - min;

      // When HR first crossed 50/65/80/95% of its range
      const thresholds = [0.5, 0.65, 0.8, 0.95].map(p => ({ pct: Math.round(p * 100), hr: Math.round(min + range * p), first_s: null }));
      for (const r of sortedRows) {
        const hr = Number(r.hr);
        for (const t of thresholds) {
          if (t.first_s == null && hr >= t.hr) t.first_s = Math.round(Number(r.time_offset_s));
        }
      }

      // Plateau detection: segments where HR stayed within ±4bpm for >30s
      const plateaus = [];
      let pStart = null; let pHR = null;
      for (let i = 0; i < sortedRows.length; i++) {
        const hr = Number(sortedRows[i].hr);
        const t = Number(sortedRows[i].time_offset_s);
        if (pStart == null) { pStart = t; pHR = hr; }
        else if (Math.abs(hr - pHR) > 4) {
          const dur = t - pStart;
          if (dur >= 30) plateaus.push({ start_s: Math.round(pStart), duration_s: Math.round(dur), avg_hr: Math.round(pHR) });
          pStart = t; pHR = hr;
        } else {
          pHR = pHR * 0.7 + hr * 0.3;
        }
      }

      return { avg, min, max, thresholds, plateaus };
    })();

    // Annotated event timeline
    const annotatedEvents = (session.event_timeline || [])
      .slice().sort((a, b) => a.time_s - b.time_s)
      .map((e, i, arr) => {
        const hr = nearestHR(e.time_s);
        const cats = Array.isArray(e.category) ? e.category : [e.category].filter(Boolean);
        const catLabels = cats.map(c => getCategoryMeta(c).label).join("+") || "Other";
        const relToClimax = session.climax_offset_s != null
          ? `${Math.abs(Math.round(e.time_s - session.climax_offset_s))}s ${e.time_s < session.climax_offset_s ? "before" : "after"} climax`
          : null;
        const gap = i > 0 ? `+${Math.round(e.time_s - arr[i - 1].time_s)}s from prev` : "session start";
        return [`[${catLabels}] @ ${formatTime(e.time_s)}`, hr ? `HR ${hr}bpm` : null, relToClimax, gap, `→ "${e.note}"`].filter(Boolean).join(" | ");
      });

    // Per-phase HR breakdown
    const phaseStats = (() => {
      if (!sortedRows.length || session.climax_offset_s == null) return null;
      const segments = {
        build:     { lo: 0,                                                         hi: session.pre_climax_offset_s ?? session.climax_offset_s },
        pre_climb: { lo: session.pre_climax_offset_s ?? session.climax_offset_s - 60, hi: session.climax_offset_s },
        climax:    { lo: session.climax_offset_s,                                   hi: session.climax_offset_s + 60 },
        recovery:  { lo: session.recovery_offset_s ?? session.climax_offset_s + 60,  hi: Infinity },
      };
      const out = {};
      for (const [name, { lo, hi }] of Object.entries(segments)) {
        const seg = sortedRows.filter(r => Number(r.time_offset_s) >= lo && Number(r.time_offset_s) <= hi);
        if (!seg.length) continue;
        const hrs = seg.map(r => Number(r.hr));
        out[name] = {
          avg: Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length),
          min: Math.round(Math.min(...hrs)),
          max: Math.round(Math.max(...hrs)),
          duration_s: Math.round(Number(seg[seg.length - 1].time_offset_s) - Number(seg[0].time_offset_s)),
        };
      }
      return out;
    })();

    const arousalProfile = userProfile && (userProfile.arousal_response_style || userProfile.arousal_notes)
      ? `\nUSER AROUSAL PROFILE:\n${JSON.stringify({
          arousal_response_style: userProfile.arousal_response_style,
          typical_build_duration: userProfile.typical_build_duration,
          climax_sensitivity: userProfile.climax_sensitivity,
          preferred_stimulation: userProfile.preferred_stimulation,
          arousal_notes: userProfile.arousal_notes,
        }, null, 2)}`
      : "";

    const res = await base44.integrations.Core.InvokeLLM({
      model: "claude_sonnet_4_6",
      prompt: `You are an expert session analyst. Write a rich, long-form TIMELINE AND AROUSAL NARRATIVE of this session. This is not a physiology lecture — it is a moment-by-moment story of how arousal unfolded, driven primarily by heart rate data and event timing.

PRIMARY FOCUS:
1. Walk through the session chronologically — what was happening at each key moment based on HR + events
2. The heart rate IS the arousal signal — narrate it like a story. When did it climb? When did it plateau? When did it spike? How fast? How steep?
3. Every event note should be contextualized: what was HR doing around it, was arousal rising or falling, how long since the previous event, what shifted
4. Factor in significant or noteworthy changes in stimulation (e.g. switching methods, pausing, adjusting intensity) as key moments that affected the arousal arc
5. Identify turning points — moments where something meaningfully changed in the arc
6. Characterize the overall "shape" of arousal: slow burn, plateau-driven, erratic spikes, clean ramp, etc.

ANATOMY / PHYSIOLOGY: Include ONLY when the HR data or events strongly suggest something physiologically notable — e.g. a sudden spike hinting at a reflex, a long plateau suggesting a specific sustained state. Do not add routine anatomy. Let the data lead.

STYLE — CRITICAL:
- Write directly to the person using "you" and "your"
- Long-form, narrative sentences — this should read like a thoughtful, detailed review of a journey through arousal
- Each timeline_narrative item should be a full paragraph (3-5 sentences), not a short bullet
- Spell out all numbers and times as words for TTS readability (e.g. "seventy-two beats per minute", "four minutes and thirty seconds")
- Do not use "bpm" — write "beats per minute"
- Do not use timestamps like "4:30" — write "four minutes and thirty seconds"

${arousalProfile}

HR DATA:
- Full trajectory (time:bpm, ~every 10s): ${hrTrajectoryDense || "not available"}
- Rate of change (time:bpm-per-min): ${hrGradients || "not available"}
- Overall: min ${hrStats?.min ?? "?"}bpm, avg ${hrStats?.avg ?? "?"}bpm, max ${hrStats?.max ?? "?"}bpm
${hrStats?.plateaus?.length ? `- Sustained plateaus detected: ${hrStats.plateaus.map(p => `${formatTime(p.start_s)} for ${formatTime(p.duration_s)} at ~${p.avg_hr}bpm`).join("; ")}` : ""}
${hrStats?.thresholds ? `- First crossed 50% of HR range at: ${hrStats.thresholds[0].first_s != null ? formatTime(hrStats.thresholds[0].first_s) : "never"}; 65% at: ${hrStats.thresholds[1].first_s != null ? formatTime(hrStats.thresholds[1].first_s) : "never"}; 80% at: ${hrStats.thresholds[2].first_s != null ? formatTime(hrStats.thresholds[2].first_s) : "never"}; 95% at: ${hrStats.thresholds[3].first_s != null ? formatTime(hrStats.thresholds[3].first_s) : "never"}` : ""}

${phaseStats ? `PHASE-BY-PHASE HR BREAKDOWN:\n${JSON.stringify(phaseStats, null, 2)}` : ""}

EVENT TIMELINE (fully annotated with HR, relative timing, inter-event gaps):
${annotatedEvents.length ? annotatedEvents.join("\n") : "No events logged"}

${sessionJournal ? `SESSION JOURNAL (person's own post-session reflections — use to contextualize what they felt during the timeline):
Emotional: ${sessionJournal.emotional_reflection || ""}
Physiological: ${sessionJournal.physiological_observations || ""}
Narrative: ${sessionJournal.experience_narrative || ""}
Insights: ${sessionJournal.insights || ""}
${sessionJournal.key_moments?.length ? `Key moments: ${sessionJournal.key_moments.join("; ")}` : ""}

Where the journal aligns with or diverges from the HR/event data is worth calling out in the narrative.

` : ""}SESSION METADATA:
${JSON.stringify({
  duration_minutes: session.duration_minutes,
  intensity: session.intensity,
  build_quality: session.build_quality,
  satisfaction: session.satisfaction,
  build_type: session.build_type === "Other" && session.custom_build_type ? session.custom_build_type : session.build_type,
  climax_duration: session.climax_duration,
  methods: session.methods,
  mood: session.mood,
  foley_size: session.foley_size,
  estim_notes: session.estim_notes,
  unusual_sensations: session.unusual_sensations,
  notes: session.notes,
  phase_markers_s: { pre_climax: session.pre_climax_offset_s, climax: session.climax_offset_s, recovery: session.recovery_offset_s },
  hr_at_climax: session.hr_at_climax,
  hr_avg_pre_to_climax: session.hr_avg_pre_to_climax,
  hr_avg_at_climax_window: session.hr_avg_at_climax_window,
}, null, 2)}`,
      response_json_schema: {
        type: "object",
        properties: {
          summary:            { type: "string",  description: "2-3 sentence overview characterizing the session's arousal shape and arc" },
          timeline_narrative: { type: "array",   items: { type: "string" }, description: "5-8 full paragraphs walking chronologically through the session using HR + events as primary lens — each item is a meaty paragraph, not a one-liner" },
          hr_arc_commentary:  { type: "array",   items: { type: "string" }, description: "3-5 specific observations about the HR curve shape — rate of climb, plateaus, spikes, descent, notable patterns" },
          arousal_momentum:   { type: "array",   items: { type: "string" }, description: "3-4 insights about how arousal momentum built, stalled, or recovered — the rhythm and texture of the session" },
          turning_points:     { type: "array",   items: { type: "string" }, description: "2-4 specific moments where something meaningfully shifted — name the time, what happened, what HR was doing" },
          what_worked:        { type: "array",   items: { type: "string" }, description: "2-4 concrete observations about what drove the most productive arousal periods" },
        },
        required: ["summary", "timeline_narrative", "hr_arc_commentary", "arousal_momentum", "turning_points", "what_worked"],
      },
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    const parsed = raw?.response ?? raw;
    setResult(parsed);
    await base44.entities.Session.update(session.id, { ai_timeline_narrative: parsed });
    setLoading(false);
  };

  const buildParas = () => {
    if (!result) return { paras: [], paraMeta: [] };
    const paras = [];
    const paraMeta = [];
    if (result.summary) { paras.push(result.summary); paraMeta.push({ type: "summary" }); }
    for (const sec of SECTION_DEFS) {
      for (const item of (result[sec.key] || [])) {
        paras.push(item);
        paraMeta.push({ type: "section", sec });
      }
    }
    return { paras, paraMeta };
  };

  const { paras, paraMeta } = buildParas();

  // Track first index for each section (for rendering section headers)
  const sectionFirstIdx = {};
  paraMeta.forEach((m, i) => {
    if (m.type === "section" && sectionFirstIdx[m.sec.key] == null) sectionFirstIdx[m.sec.key] = i;
  });

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <button className="flex items-center gap-1.5 flex-1 text-left" onClick={() => setCollapsed((v) => !v)}>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
            <Activity className="w-4 h-4" /> Timeline &amp; Arousal Narrative
          </h3>
          {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground ml-1" /> : <ChevronUp className="w-4 h-4 text-muted-foreground ml-1" />}
        </button>
        <Button size="sm" onClick={analyze} disabled={loading} className="h-7 text-xs gap-1.5">
          {loading
            ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</>
            : <><Activity className="w-3 h-3" />{result ? "Re-analyze" : "Analyze"}</>}
        </Button>
      </div>

      {!collapsed && !result && !loading && (
        <p className="text-xs text-muted-foreground">
          Long-form, moment-by-moment arousal narrative driven by HR data and event timing. Less anatomy — more story. Uses Claude Sonnet.
        </p>
      )}

      {!collapsed && result && (
        <TTSReader
          sessionId={session.id + "_timeline"}
          title="Timeline & Arousal Narrative"
          sessionDate={session.date}
          paragraphs={paras}
          renderParagraph={(text, idx, isActive, isBuffering) => {
            const meta = paraMeta[idx];
            if (!meta) return null;

            if (meta.type === "summary") {
              return (
                <p className={`text-base font-medium leading-relaxed border-l-2 pl-3 py-1 transition-all duration-200 rounded-r-md flex items-center gap-2 ${isActive ? "border-primary bg-primary/8 text-foreground" : isBuffering ? "border-primary/60 bg-primary/5 text-foreground" : "border-primary/50 text-foreground"}`}>
                  {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />}
                  {text}
                </p>
              );
            }

            const { sec } = meta;
            const isFirst = sectionFirstIdx[sec.key] === idx;

            return (
              <div>
                {isFirst && (
                  <p className="text-xs font-semibold flex items-center gap-1.5 mt-4 mb-1.5 pt-2 border-t border-border" style={{ color: sec.color }}>
                    {sec.icon}{sec.label}
                  </p>
                )}
                <li
                  className="text-base leading-relaxed pl-3 border-l-2 py-1.5 list-none transition-all duration-200 rounded-r-md flex items-start gap-2"
                  style={{
                    borderColor: isActive ? sec.color : isBuffering ? sec.color + "99" : sec.color + "44",
                    background: isActive ? sec.color + "18" : isBuffering ? sec.color + "0a" : "transparent",
                    color: "hsl(var(--foreground))",
                  }}
                >
                  {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin mt-1" />}
                  {text}
                </li>
              </div>
            );
          }}
        />
      )}
    </div>
  );
}