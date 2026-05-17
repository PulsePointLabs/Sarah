import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Brain, Activity, Lightbulb, TrendingUp, Zap, Target, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import TTSReader from "./TTSReader";
import { EVENT_CATEGORIES } from "./session-form/EventTimelineSection";

function getCategoryMeta(value) {
  return EVENT_CATEGORIES.find((c) => c.value === value) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

const SECTION_DEFS = [
  { key: "arousal_assessment",     label: "Arousal Assessment",     color: "hsl(var(--chart-2))", icon: <TrendingUp className="w-3.5 h-3.5" /> },
  { key: "event_analysis",         label: "Event Analysis",         color: "hsl(var(--chart-1))", icon: <Activity className="w-3.5 h-3.5" /> },
  { key: "near_climax_estimate",   label: "Near-Climax Estimate",   color: "hsl(var(--accent))",  icon: <Target className="w-3.5 h-3.5" /> },
  { key: "physiological_findings", label: "Physiological Findings", color: "hsl(var(--chart-3))", icon: <Zap className="w-3.5 h-3.5" /> },
  { key: "discomfort_analysis",    label: "Discomfort Analysis",    color: "hsl(var(--destructive))", icon: <AlertCircle className="w-3.5 h-3.5" /> },
  { key: "recommendations",        label: "Recommendations",        color: "hsl(var(--primary))", icon: <Lightbulb className="w-3.5 h-3.5" /> },
];

export default function NoClimaxAIPanel({ session, timelineRows, userProfile }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(session.ai_no_climax ?? null);

  const analyze = async () => {
    setLoading(true);
    setResult(null);

    // HR summary
    const hrSummary = timelineRows.length > 0 ? {
      total_points: timelineRows.length,
      duration_s: Math.round(Math.max(...timelineRows.map(r => Number(r.time_offset_s) || 0))),
      hr_min: Math.round(Math.min(...timelineRows.map(r => Number(r.hr)))),
      hr_max: Math.round(Math.max(...timelineRows.map(r => Number(r.hr)))),
      hr_avg: session.avg_hr,
    } : null;

    // Nearest HR lookup
    const sortedRows = [...timelineRows].sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));
    const nearestHR = (time_s) => {
      if (!sortedRows.length) return null;
      let best = sortedRows[0];
      let bestDist = Math.abs(Number(sortedRows[0].time_offset_s) - time_s);
      for (const r of sortedRows) {
        const d = Math.abs(Number(r.time_offset_s) - time_s);
        if (d < bestDist) { bestDist = d; best = r; }
        if (Number(r.time_offset_s) > time_s + 10) break;
      }
      return Math.round(Number(best.hr));
    };

    // Annotated event timeline
    const eventTimeline = (session.event_timeline || []).map(e => {
      const m = Math.floor(e.time_s / 60);
      const s = (e.time_s % 60).toString().padStart(2, '0');
      const hr = nearestHR(e.time_s);
      const cats = Array.isArray(e.category) ? e.category : [e.category].filter(Boolean);
      const catLabels = cats.map(c => getCategoryMeta(c).label).join("+");
      return `[${catLabels}] ${m}:${s} — ${e.note}${hr != null ? ` [HR: ${hr} bpm]` : ''}`;
    });

    // Detect HR peaks as potential near-climax moments
    let hrPeaks = [];
    if (sortedRows.length > 10) {
      const windowSize = Math.max(3, Math.floor(sortedRows.length / 20));
      for (let i = windowSize; i < sortedRows.length - windowSize; i++) {
        const curr = Number(sortedRows[i].hr);
        const prev = Number(sortedRows[i - windowSize].hr);
        const next = Number(sortedRows[i + windowSize].hr);
        if (curr > prev + 8 && curr > next + 8) {
          hrPeaks.push({ time_s: Number(sortedRows[i].time_offset_s), hr: Math.round(curr) });
        }
      }
      hrPeaks = hrPeaks.reduce((acc, pk) => {
        if (!acc.length || pk.time_s - acc[acc.length - 1].time_s > 60) acc.push(pk);
        return acc;
      }, []);
    }

    // E-Stim screenshots
    const estimScreenshots = [
      ...(session.estim_screenshots || []),
      ...(session.estim_screenshot && !(session.estim_screenshots?.includes(session.estim_screenshot)) ? [session.estim_screenshot] : []),
    ].filter(Boolean);

    // User arousal profile
    const arousalProfile = userProfile && (userProfile.arousal_response_style || userProfile.climax_sensitivity || userProfile.arousal_notes)
      ? `\nUSER AROUSAL PROFILE:\n${JSON.stringify({
          arousal_response_style: userProfile.arousal_response_style,
          typical_build_duration: userProfile.typical_build_duration,
          climax_sensitivity: userProfile.climax_sensitivity,
          preferred_stimulation: userProfile.preferred_stimulation,
          refractory_pattern: userProfile.refractory_pattern,
          arousal_notes: userProfile.arousal_notes,
        }, null, 2)}\nUse this profile to contextualize the incomplete arc — compare peak arousal, build pattern, and events against the user's known response style. Note deviations.`
      : "";

    const timeOfDay = (() => {
      if (!session.start_time) return undefined;
      const h = parseInt(session.start_time.split(":")[0], 10);
      if (h >= 5 && h < 12) return "morning";
      if (h >= 12 && h < 17) return "afternoon";
      if (h >= 17 && h < 21) return "evening";
      return "night";
    })();

    const res = await base44.integrations.Core.InvokeLLM({
      model: "claude_sonnet_4_6",
      ...(estimScreenshots.length > 0 ? { file_urls: estimScreenshots } : {}),
      prompt: `You are an expert sexual arousal physiologist and narrative writer. Analyze this INCOMPLETE session — it did NOT result in climax. Write a rich, story-driven analysis as if narrating a fascinating physiological journey. Do NOT treat this as a failed session — it is a valuable dataset. Write directly to the person using "you" and "your" throughout, like a knowledgeable friend reviewing their experience.

STYLE — CRITICAL (this output is read aloud via text-to-speech):
- Write in long-form, flowing narrative sentences — paragraphs, not bullet fragments
- Each array item should be 2-4 full sentences that flow naturally when spoken aloud
- Spell out ALL numbers and measurements as words: "one hundred and five beats per minute" not "105 bpm", "six out of ten" not "6/10", "thirty-nine minutes" not "39 min"
- Never use abbreviations: write "beats per minute" not "bpm", "heart rate" not "HR"
- Never use timestamp notation like "4:30" — write "four minutes and thirty seconds in" or "around the four-minute mark"
- Never start a sentence with a digit — always spell it out
- Avoid clinical bullet-point phrasing; write as if telling a story
- Keep the tone curious, warm, and analytically engaged — like a thoughtful expert who finds this data genuinely interesting

${arousalProfile}
${estimScreenshots.length > 0 ? `\nE-STIM SCREENSHOTS ATTACHED (${estimScreenshots.length}): Analyze waveform types, frequencies, pulse widths, and channel configurations. Describe how these settings shaped the arousal experience and whether they were approaching climax-sufficient intensity — in narrative form.` : ""}
${hrPeaks.length > 0 ? `\nDETECTED HEART RATE PEAK EVENTS (potential near-threshold moments):\n${hrPeaks.map(p => `- Around the ${Math.floor(p.time_s/60)}-minute mark — heart rate spike to ${p.hr} beats per minute`).join('\n')}` : ""}
${eventTimeline.length > 0 ? `\nSESSION EVENT TIMELINE:\n${eventTimeline.join('\n')}\nNarrate each event: what does it reveal about arousal state, stimulation dynamics, and physiological response at that moment? Tell the story of how the arc unfolded.` : ""}

Session data:
${JSON.stringify({
  date: session.date?.slice(0, 10),
  time_of_day: timeOfDay,
  duration_minutes: session.duration_minutes,
  peak_arousal_level: session.intensity,
  build_quality: session.build_quality,
  build_type: session.build_type === "Other" && session.custom_build_type ? session.custom_build_type : session.build_type,
  overall_satisfaction: session.satisfaction,
  mood: session.mood,
  environment: session.environment,
  methods: session.methods,
  foley_size: session.foley_size,
  foley_type: session.foley_type,
  estim_notes: session.estim_notes,
  sleeve_type: session.sleeve_type,
  tens_placement: session.tens_placement,
  hydration: session.hydration,
  substances: session.substances,
  discomfort_entries: session.discomfort_entries?.length > 0 ? session.discomfort_entries : undefined,
  unusual_sensations: session.unusual_sensations,
  notes: session.notes,
  hr_data: hrSummary,
}, null, 2)}`,
      response_json_schema: {
        type: "object",
        properties: {
          summary:                 { type: "string",  description: "2-3 sentence narrative overview of the session arc and context — spoken naturally, all numbers spelled out" },
          arousal_assessment:      { type: "array",   items: { type: "string" }, description: "3-5 narrative paragraphs describing how arousal built, plateaued, or stalled — use heart rate as the primary lens, spell out all numbers" },
          event_analysis:          { type: "array",   items: { type: "string" }, description: "One narrative paragraph per key event, contextualizing what was happening physiologically at that moment — no timestamps as digits" },
          near_climax_estimate:    { type: "array",   items: { type: "string" }, description: "2-4 narrative paragraphs estimating how close threshold was reached and at which moments — story-driven, numbers as words" },
          physiological_findings:  { type: "array",   items: { type: "string" }, description: "3-5 narrative observations about autonomic, muscular, or cardiovascular patterns — accessible language, no clinical jargon without explanation" },
          discomfort_analysis:     { type: "array",   items: { type: "string" }, description: "Narrative paragraphs about any discomfort entries — only include this section if discomfort was logged" },
          recommendations:         { type: "array",   items: { type: "string" }, description: "3-5 specific, actionable narrative recommendations for future sessions — warm and direct tone" },
        },
        required: ["summary", "arousal_assessment", "event_analysis", "near_climax_estimate", "physiological_findings", "recommendations"],
      },
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    const parsed = raw?.response ?? raw;
    setResult(parsed);
    await base44.entities.Session.update(session.id, { ai_no_climax: parsed });
    setLoading(false);
  };

  // Build flat paragraph list + metadata for TTSReader rendering
  const paras = [];
  const paraMeta = [];
  if (result) {
    if (result.summary) { paras.push(result.summary); paraMeta.push({ type: "summary" }); }
    for (const sec of SECTION_DEFS) {
      for (const item of (result[sec.key] || [])) {
        paras.push(item);
        paraMeta.push({ type: "section", sec });
      }
    }
  }

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
          <Brain className="w-4 h-4" /> AI Incomplete Session Analysis
        </h3>
        <Button size="sm" onClick={analyze} disabled={loading} className="h-7 text-xs gap-1.5">
          {loading
            ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</>
            : <><Brain className="w-3 h-3" />{result ? "Re-analyze" : "Analyze"}</>}
        </Button>
      </div>

      {!result && !loading && (
        <p className="text-xs text-muted-foreground">
          Full-depth AI analysis: arousal arc assessment, event timeline review, near-climax threshold estimation, physiological findings, and targeted recommendations. Uses Claude Sonnet.
        </p>
      )}

      {result && (() => {
        // Group section items by section key for visual headers + TTS
        const sections = [];
        let curSec = null;
        paras.forEach((text, i) => {
          const meta = paraMeta[i];
          if (meta.type === "summary") return;
          if (!curSec || curSec.key !== meta.sec.key) {
            curSec = { key: meta.sec.key, sec: meta.sec, items: [{ text, i }] };
            sections.push(curSec);
          } else {
            curSec.items.push({ text, i });
          }
        });

        return (
          <TTSReader
            sessionId={session.id}
            title="AI Incomplete Session Analysis"
            sessionDate={session.date}
            paragraphs={paras}
            renderParagraph={(text, idx, isActive) => {
              const meta = paraMeta[idx];
              if (!meta) return null;

              if (meta.type === "summary") {
                return (
                  <p className={`text-base font-medium leading-relaxed border-l-2 pl-3 py-1 transition-all duration-200 rounded-r-md ${isActive ? "border-primary bg-primary/8 text-foreground" : "border-primary/50 text-foreground"}`}>
                    {text}
                  </p>
                );
              }

              const { sec } = meta;
              // Check if this is the first item in its section → render section header above
              const isFirstInSection = sections.find(s => s.key === sec.key)?.items[0]?.i === idx;

              return (
                <div key={idx}>
                  {isFirstInSection && (
                    <p className="text-xs font-semibold flex items-center gap-1.5 mt-3 mb-1.5 pt-2 border-t border-border" style={{ color: sec.color }}>
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
        );
      })()}
    </div>
  );
}