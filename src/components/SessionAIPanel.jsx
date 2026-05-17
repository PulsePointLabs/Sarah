import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Brain, AlertCircle, Activity, Lightbulb, TrendingUp, Zap, ChevronDown, ChevronUp } from "lucide-react";
import TTSReader from "./TTSReader";
import { Button } from "@/components/ui/button";
import { EVENT_CATEGORIES } from "./session-form/EventTimelineSection";
function buildSessionContext(session, timelineRows) {
  const hrMin = timelineRows.length ? Math.round(Math.min(...timelineRows.map(r => Number(r.hr)))) : null;
  const hrMax = timelineRows.length ? Math.round(Math.max(...timelineRows.map(r => Number(r.hr)))) : null;
  return [
    `Session date: ${session.date?.slice(0, 10)}`,
    `Duration: ${session.duration_minutes ?? "?"}min`,
    `Methods: ${(session.methods || []).join(", ")}`,
    session.foley_size ? `Foley: ${session.foley_size}Fr ${session.foley_type || ""}` : null,
    session.estim_notes ? `E-Stim notes: ${session.estim_notes}` : null,
    `Intensity: ${session.intensity}/10, Build quality: ${session.build_quality}/10, Satisfaction: ${session.satisfaction}/10`,
    `Build type: ${session.build_type}${session.custom_build_type ? " — " + session.custom_build_type : ""}`,
    `Climax duration: ${session.climax_duration ?? "?"}`,
    `Mood: ${session.mood}, Hydration: ${session.hydration}`,
    hrMin != null ? `HR: min ${hrMin}, avg ${session.avg_hr ?? "?"}, max ${hrMax}, at climax ${session.hr_at_climax ?? "?"}` : null,
    session.pre_climax_offset_s != null ? `Phase markers: pre-climax ${Math.round(session.pre_climax_offset_s)}s, climax ${Math.round(session.climax_offset_s)}s, recovery ${session.recovery_offset_s != null ? Math.round(session.recovery_offset_s) + "s" : "?"}` : null,
    session.ejaculate_volume ? `Ejaculate: ${session.ejaculate_volume}` : null,
    session.unusual_sensations ? `Unusual sensations: ${session.unusual_sensations}` : null,
    (session.discomfort_entries || []).length ? `Discomfort: ${session.discomfort_entries.map(e => `sev ${e.severity}/10 — ${e.note}`).join("; ")}` : null,
    (session.event_timeline || []).length ? `Events: ${session.event_timeline.map(e => `[${e.time_s}s] ${e.note}`).join(" | ")}` : null,
    session.notes ? `Session notes: ${session.notes}` : null,
    session.ai_analysis?.summary ? `AI analysis summary: ${session.ai_analysis.summary}` : null,
  ].filter(Boolean).join("\n");
}

function getCategoryMeta(value) {
  return EVENT_CATEGORIES.find((c) => c.value === value) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

const SECTION_COLORS = {
  primary: "hsl(var(--primary))",
  "chart-1": "hsl(var(--chart-1))",
  "chart-2": "hsl(var(--chart-2))",
  "chart-4": "hsl(var(--chart-4))",
  accent: "hsl(var(--accent))",
  destructive: "hsl(var(--destructive))",
};

function Section({ icon, title, color, children }) {
  return (
    <div className="bg-muted/60 rounded-lg p-3 space-y-2">
      <p className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: SECTION_COLORS[color] }}>
        {icon}{title}
      </p>
      <ul className="space-y-1.5">{children}</ul>
    </div>
  );
}

function Item({ text }) {
  return (
    <li className="text-sm text-foreground leading-relaxed pl-3 border-l-2 border-primary/40 py-1">
      {text}
    </li>
  );
}

export default function SessionAIPanel({ session, timelineRows, emgRows = [], userProfile, sessionJournal }) {
  const [collapsed, setCollapsed] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(session.ai_analysis ?? null);

  const analyze = async () => {
    setLoading(true);
    setResult(null);

    // Build EMG summary for AI
    const emgSummary = (() => {
      if (!emgRows.length) return null;
      const isDual = emgRows.some((r) => r.left_pct != null || r.right_pct != null);
      const step = Math.max(1, Math.floor(emgRows.length / 200));
      const sampled = emgRows.filter((_, i) => i % step === 0);

      if (isDual) {
        const leftPcts = sampled.map((r) => r.left_pct).filter((v) => v != null);
        const rightPcts = sampled.map((r) => r.right_pct).filter((v) => v != null);
        const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
        const max = (arr) => arr.length ? Math.round(Math.max(...arr)) : null;
        // Detect clipping
        const leftClipPct = leftPcts.length ? Math.round((leftPcts.filter((v) => v >= 99).length / leftPcts.length) * 100) : 0;
        const rightClipPct = rightPcts.length ? Math.round((rightPcts.filter((v) => v >= 99).length / rightPcts.length) * 100) : 0;
        // Trajectory (sampled as "time_s:pct" pairs)
        const leftTraj = sampled.filter((r) => r.left_pct != null).map((r) => `${r.time_s.toFixed(1)}s:${Math.round(r.left_pct)}%`).join(" ");
        const rightTraj = sampled.filter((r) => r.right_pct != null).map((r) => `${r.time_s.toFixed(1)}s:${Math.round(r.right_pct)}%`).join(" ");
        return {
          channel_mode: "dual",
          total_samples: emgRows.length,
          target_area: session.emg_target_area || undefined,
          sensor_type: session.emg_sensor_type || undefined,
          left_avg_pct: avg(leftPcts),
          left_max_pct: max(leftPcts),
          left_clip_percent_of_time: leftClipPct,
          right_avg_pct: avg(rightPcts),
          right_max_pct: max(rightPcts),
          right_clip_percent_of_time: rightClipPct,
          left_trajectory: leftTraj,
          right_trajectory: rightTraj,
          calibration: {
            rest_l: session.emg_rest_left,
            max_l: session.emg_max_left,
            rest_r: session.emg_rest_right,
            max_r: session.emg_max_right,
            lr_flipped: session.emg_left_right_flipped,
          },
          placement_notes: {
            left: session.emg_left_placement_notes,
            right: session.emg_right_placement_notes,
            calibration: session.emg_calibration_notes,
            general: session.emg_general_notes,
          },
          placement_photo_tags: (session.emg_placement_photos || []).map((p) => `${p.tag}: ${p.caption}`).filter(Boolean),
        };
      } else {
        const pcts = sampled.map((r) => r.level_pct).filter((v) => v != null);
        const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
        const clipPct = pcts.length ? Math.round((pcts.filter((v) => v >= 99).length / pcts.length) * 100) : 0;
        const traj = sampled.filter((r) => r.level_pct != null).map((r) => `${r.time_s.toFixed(1)}s:${Math.round(r.level_pct)}%`).join(" ");
        return {
          channel_mode: "single",
          total_samples: emgRows.length,
          target_area: session.emg_target_area || undefined,
          sensor_type: session.emg_sensor_type || undefined,
          avg_pct: avg(pcts),
          max_pct: pcts.length ? Math.round(Math.max(...pcts)) : null,
          clip_percent_of_time: clipPct,
          trajectory: traj,
          calibration: {
            rest: session.emg_rest_left,
            max: session.emg_max_left,
            calibration_notes: session.emg_calibration_notes,
          },
          placement_notes: session.emg_left_placement_notes,
          general_notes: session.emg_general_notes,
          placement_photo_tags: (session.emg_placement_photos || []).map((p) => `${p.tag}: ${p.caption}`).filter(Boolean),
        };
      }
    })();

    const estimScreenshots = [
      ...(session.estim_screenshots || []),
      ...(session.estim_screenshot && !(session.estim_screenshots?.includes(session.estim_screenshot)) ? [session.estim_screenshot] : []),
    ].filter(Boolean);

    const hrSummary = timelineRows.length > 0 ? {
      total_points: timelineRows.length,
      duration_s: Math.round(Math.max(...timelineRows.map(r => Number(r.time_offset_s) || 0))),
      hr_min: Math.round(Math.min(...timelineRows.map(r => Number(r.hr)))),
      hr_max: Math.round(Math.max(...timelineRows.map(r => Number(r.hr)))),
    } : null;

    // Sample HR trajectory for the prompt (~1 point every 15s)
    const hrTrajectory = (() => {
      if (!timelineRows.length) return null;
      const step = Math.max(1, Math.floor(timelineRows.length / 60));
      return timelineRows
        .filter((_, i) => i % step === 0)
        .map(r => `${Math.round(Number(r.time_offset_s))}s:${Math.round(Number(r.hr))}`)
        .join("  ");
    })();

    // Build a sorted HR lookup from timeline rows for nearest-HR matching
    const sortedRows = [...timelineRows].sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));
    const nearestHR = (time_s) => {
      if (!sortedRows.length) return null;
      let best = sortedRows[0];
      let bestDist = Math.abs(Number(sortedRows[0].time_offset_s) - time_s);
      for (const r of sortedRows) {
        const d = Math.abs(Number(r.time_offset_s) - time_s);
        if (d < bestDist) { bestDist = d; best = r; }
        if (Number(r.time_offset_s) > time_s + 10) break; // past the window, stop early
      }
      return Math.round(Number(best.hr));
    };

    const formatTimeWords = (seconds) => {
      const m = Math.floor(seconds / 60);
      const s = Math.round(seconds % 60);
      if (m === 0) return `${s} second${s !== 1 ? 's' : ''}`;
      if (s === 0) return `${m} minute${m !== 1 ? 's' : ''}`;
      return `${m} minute${m !== 1 ? 's' : ''} and ${s} second${s !== 1 ? 's' : ''}`;
    };

    const eventTimeline = (session.event_timeline || []).map(e => {
      const timeWords = formatTimeWords(e.time_s);
      const hr = nearestHR(e.time_s);
      const catMeta = getCategoryMeta(e.category);
      const relToClimax = session.climax_offset_s != null ? Math.round(e.time_s - session.climax_offset_s) : null;
      const relStr = relToClimax != null ? ` (${formatTimeWords(Math.abs(relToClimax))} ${relToClimax >= 0 ? 'after' : 'before'} climax)` : "";
      return `[${catMeta.label}] at ${timeWords}${relStr} — ${e.note}${hr != null ? ` (heart rate: ${hr} beats per minute)` : ''}`;
    });

    const arousalProfile = userProfile && (userProfile.arousal_response_style || userProfile.arousal_notes || userProfile.climax_sensitivity) ? `

USER AROUSAL PROFILE:
${JSON.stringify({
  arousal_response_style: userProfile.arousal_response_style,
  typical_build_duration: userProfile.typical_build_duration,
  climax_sensitivity: userProfile.climax_sensitivity,
  preferred_stimulation: userProfile.preferred_stimulation,
  refractory_pattern: userProfile.refractory_pattern,
  arousal_notes: userProfile.arousal_notes,
}, null, 2)}

Use this arousal profile to personalize analysis: compare the observed build arc and climax pattern against the user's known response style. Note deviations (e.g. faster/slower than typical, more/less sensitive). Reference preferred methods when interpreting session effectiveness.` : "";

    const journalContext = sessionJournal ? `

SESSION JOURNAL (person's own reflections after this session — treat as first-person subjective data):
Emotional reflection: ${sessionJournal.emotional_reflection || ""}
Physiological observations: ${sessionJournal.physiological_observations || ""}
Experience narrative: ${sessionJournal.experience_narrative || ""}
Insights: ${sessionJournal.insights || ""}
Next session intentions: ${sessionJournal.next_session_intentions || ""}
${sessionJournal.key_moments?.length ? `Key moments noted: ${sessionJournal.key_moments.join("; ")}` : ""}

Factor the journal into your analysis — where the person's subjective experience aligns with or diverges from the objective physiological data is especially worth noting.` : "";

    const res = await base44.integrations.Core.InvokeLLM({
      model: "claude_sonnet_4_6",
      ...(estimScreenshots.length > 0 ? { file_urls: estimScreenshots } : {}),
      prompt: `You are an expert physiologist and anatomist specializing in sexual response. Analyze this session integrating arousal physiology, anatomy, heart rate data, event timeline, and subjective experience into a cohesive narrative. Write directly to the person — use "you" and "your" throughout, as if speaking to them personally.

PHYSIOLOGICAL & ANATOMICAL LENS — CONDITIONAL USE ONLY:
- Only mention specific physiological phases (e.g. emission, expulsion, plateau) or anatomical structures (e.g. pudendal nerve, bulbocavernosus, prostatic urethra) when the session data — an event note, HR pattern, subjective metric, or logged sensation — gives you a concrete reason to do so. Never insert these as generic background explanation.
- Interpret HR trajectory as a real-time window into sympathetic/parasympathetic balance — but only narrate a mechanism if the HR data actually shows it (e.g. a clear spike, an unexpected plateau, a slow recovery).
- If foley or urethral stimulation is logged, discuss urethral sensory dynamics — but only in terms of what actually happened (logged sensations, HR response, notes). Skip if there's nothing to connect it to.
- If e-stim is present, discuss fiber recruitment and frequency effects only if the e-stim notes or settings screenshots give you something specific to work with.
- Connect subjective sensations (pressure, throb, tightness, wave) to anatomical generators ONLY if the user actually logged those sensations.
- Interpret discomfort anatomically ONLY if discomfort entries are present.
- The goal is a tight, evidence-driven analysis of what actually happened — not a physiology lecture. Every anatomical or physiological claim must be traceable to a specific data point in the session.
${emgSummary ? `
EMG INTERPRETATION RULES — apply carefully:
- EMG % is NORMALIZED RELATIVE ACTIVATION, NOT absolute force. Never claim EMG % equals muscle force.
- Left/right comparisons are only valid when each channel was independently calibrated.
- If placement differs between sides, note that asymmetry may reflect placement differences, not true muscle asymmetry.
- Clipping (100%) means timing data is useful but high-end intensity detail is compressed — recommend raising max calibration or lowering gain.
- One flat/noisy channel suggests sensor dropout, poor contact, or cross-talk — call this out.
- If diff_pct is near zero during high activity, describe bilateral symmetry.
- If one side rises earlier, describe it as a lead/phase difference.
- If EMG peaks precede HR rise, describe EMG leading the HR response.
- If HR rises without EMG change, note this as a possible autonomic or non-muscular response.
- Describe the likely target muscle based on placement notes and photo tags when available.` : ""}

CRITICAL FOR TEXT-TO-SPEECH QUALITY:
- Write all times as words: "ten minutes and thirty seconds" not "10:30"
- Spell out all numbers as words (e.g., "ten beats per minute" not "10 bpm")
- Write in conversational, sentence-based prose with natural pauses
- Use short sentences and simple grammar optimized for audio readability
- Avoid dense jargon — explain anatomical concepts briefly but accessibly
- Use commas and periods to create natural speech cadence
${arousalProfile}${estimScreenshots.length > 0 ? `

E-STIM SCREENSHOTS ATTACHED (${estimScreenshots.length}): Analyze the waveform types, frequencies, pulse widths, and channel configurations. Interpret how these settings recruited sensory vs motor fibers, shaped smooth muscle tone, and drove the arousal arc through the session.` : ""}${eventTimeline.length > 0 ? `

SESSION EVENT TIMELINE (with heart rate at each moment):
${eventTimeline.join('\n')}

This is the primary dataset. For each event: interpret the arousal state at that HR level, what the note reveals about the underlying physiology or anatomy, and how it connects to the session arc. Identify physiological turning points — moments where HR + event note together reveal a shift in autonomic or sensory state.` : ""}

${hrTrajectory ? `HR TRAJECTORY (time_s:bpm, sampled):
${hrTrajectory}

Use this to trace sympathetic activation patterns, identify arousal plateaus, and correlate HR changes to event timing.` : ""}

Session data:
${JSON.stringify({
  date: session.date ? (() => {
    const d = new Date(session.date);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  })() : undefined,
  time_of_day: session.start_time ? (() => {
    const h = parseInt(session.start_time.split(":")[0], 10);
    if (h >= 5 && h < 12) return "morning";
    if (h >= 12 && h < 17) return "afternoon";
    if (h >= 17 && h < 21) return "evening";
    return "night";
  })() : undefined,
  duration_minutes: session.duration_minutes,
  intensity: session.intensity,
  satisfaction: session.satisfaction,
  build_quality: session.build_quality,
  build_type: session.build_type,
  climax_duration: session.climax_duration,
  mood: session.mood,
  environment: session.environment,
  methods: session.methods,
  foley_size: session.foley_size,
  foley_type: session.foley_type,
  estim_notes: session.estim_notes,
  ejaculate_volume: session.ejaculate_volume,
  hydration: session.hydration,
  substances: session.substances,
  discomfort_entries: session.discomfort_entries?.length > 0 ? session.discomfort_entries : undefined,
  unusual_sensations: session.unusual_sensations,
  refractory_notes: session.refractory_notes,
  notes: session.notes,
  hr: hrSummary ? { avg: session.avg_hr, max: session.max_hr, hr_at_climax: session.hr_at_climax, min: hrSummary.hr_min } : undefined,
  phase_markers_s: {
    pre_climax: session.pre_climax_offset_s,
    climax: session.climax_offset_s,
    recovery: session.recovery_offset_s,
  },
}, null, 2)}

${session.discomfort_entries?.length > 0 ? "Discomfort entries present — analyze each for likely anatomical cause (nerve, tissue, positional), severity context, and whether it disrupted the arousal arc." : ""}
${emgSummary ? `\nEMG DATA:\n${JSON.stringify(emgSummary, null, 2)}\n\nAnalyze EMG activation patterns alongside HR. Reference timing relationships between EMG and HR changes. Check for clipping, asymmetry, noise, and relate activation bursts to event markers and phase markers when present. Describe what muscle the sensor likely captures based on placement notes and target area.` : ""}
${journalContext}

Provide a rich, physiologically-grounded analysis that tells the story of this session — from the autonomic and anatomical level up to the subjective experience.`,
      response_json_schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          arousal_arc: { type: "array", items: { type: "string" } },
          event_analysis: { type: "array", items: { type: "string" } },
          emg_analysis: { type: "array", items: { type: "string" }, description: "EMG signal quality, activation patterns, L/R comparison, EMG vs HR, calibration notes — only if EMG data present" },
          notable_findings: { type: "array", items: { type: "string" } },
          recommendations: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "arousal_arc", "event_analysis", "notable_findings", "recommendations"],
      },
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    const parsed = raw?.response ?? raw;
    setResult(parsed);
    await base44.entities.Session.update(session.id, { ai_analysis: parsed });
    setLoading(false);
  };

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <button className="flex items-center gap-1.5 flex-1 text-left" onClick={() => setCollapsed((v) => !v)}>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
            <Brain className="w-4 h-4" /> AI Session Analysis
          </h3>
          {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground ml-1" /> : <ChevronUp className="w-4 h-4 text-muted-foreground ml-1" />}
        </button>
        <Button size="sm" onClick={analyze} disabled={loading} className="h-7 text-xs gap-1.5">
          {loading
            ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</>
            : <><Brain className="w-3 h-3" />Analyze</>}
        </Button>
      </div>

      {!collapsed && !result && !loading && (
        <p className="text-xs text-muted-foreground">
          Click Analyze to generate a detailed AI physiological breakdown of this session. Uses Claude Sonnet.
        </p>
      )}



      {!collapsed && result && (() => {
        // Support both old schema (hr_analysis/phase_analysis) and new schema (arousal_arc/event_analysis)
        const arousalItems = result.arousal_arc || result.phase_analysis || [];
        const eventItems = result.event_analysis || result.hr_analysis || [];
        const emgItems = result.emg_analysis || [];

        const paras = [
          result.summary,
          ...arousalItems,
          ...eventItems,
          ...emgItems,
          ...(result.notable_findings || []),
          ...(result.recommendations || []),
        ].filter(Boolean);

        // Build a flat index → section label map for rendering
        let idx = 0;
        const sections = [];
        if (result.summary) sections.push({ label: null, color: "primary", items: [result.summary], start: idx++ });
        if (arousalItems.length) { sections.push({ label: "Arousal Arc", color: "chart-2", icon: <TrendingUp className="w-3.5 h-3.5" />, items: arousalItems, start: idx }); idx += arousalItems.length; }
        if (eventItems.length) { sections.push({ label: "Event Analysis", color: "chart-1", icon: <Activity className="w-3.5 h-3.5" />, items: eventItems, start: idx }); idx += eventItems.length; }
        if (emgItems.length) { sections.push({ label: "EMG Analysis", color: "chart-3", icon: <Activity className="w-3.5 h-3.5" />, items: emgItems, start: idx }); idx += emgItems.length; }
        if (result.notable_findings?.length) { sections.push({ label: "Notable Findings", color: "chart-4", icon: <Zap className="w-3.5 h-3.5" />, items: result.notable_findings, start: idx }); idx += result.notable_findings.length; }
        if (result.recommendations?.length) { sections.push({ label: "Recommendations", color: "accent", icon: <Lightbulb className="w-3.5 h-3.5" />, items: result.recommendations, start: idx }); }

        return (
          <TTSReader
            sessionId={session.id}
            title="AI Session Analysis"
            sessionDate={session.date}
            paragraphs={paras}
            renderParagraph={(text, paraIdx, isActive, isBuffering) => {
              // Find which section this paragraph belongs to
              let section = sections[0];
              for (const sec of sections) {
                if (paraIdx >= sec.start) section = sec;
              }
              const isSummary = section.label === null;
              if (isSummary) {
                return (
                  <p className={`text-base font-medium leading-relaxed border-l-2 pl-3 py-1 transition-all duration-200 rounded-r-md flex items-center gap-2 ${isActive ? "border-primary bg-primary/8 text-foreground" : isBuffering ? "border-primary/60 bg-primary/5 text-foreground" : "border-primary/50 text-foreground"}`}>
                    {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />}
                    {text}
                  </p>
                );
              }
              return (
                <li className={`text-base leading-relaxed pl-3 border-l-2 py-1 transition-all duration-200 rounded-r-md list-none flex items-center gap-2 ${isActive ? "border-primary bg-primary/8 text-foreground font-medium" : isBuffering ? "border-primary/60 bg-primary/5 text-foreground" : "border-primary/30 text-foreground"}`}>
                  {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />}
                  {text}
                </li>
              );
            }}
          />
        );
      })()}
    </div>
  );
}