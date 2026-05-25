import { useState } from "react";
import { Activity, AlertCircle, Brain, Lightbulb, ScanSearch, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { buildAIGroundingContext, PERSONALIZED_ANATOMY_OUTPUT_RULE } from "@/lib/aiGrounding";
import TTSReader from "./TTSReader";
import { EVENT_CATEGORIES, EXPLORATION_EVENT_CATEGORIES } from "./session-form/EventTimelineSection";

const SECTION_DEFS = [
  { key: "telemetry_findings", label: "Telemetry Findings", icon: <Activity className="h-3.5 w-3.5" />, color: "hsl(var(--chart-2))" },
  { key: "mechanical_findings", label: "Mechanical Findings", icon: <ScanSearch className="h-3.5 w-3.5" />, color: "hsl(var(--primary))" },
  { key: "comfort_safety_findings", label: "Comfort & Safety", icon: <ShieldCheck className="h-3.5 w-3.5" />, color: "hsl(var(--chart-3))" },
  { key: "recommendations", label: "Review Notes", icon: <Lightbulb className="h-3.5 w-3.5" />, color: "hsl(var(--chart-4))" },
];

function categoryLabel(value) {
  return [...EVENT_CATEGORIES, ...EXPLORATION_EVENT_CATEGORIES].find((item) => item.value === value)?.label || String(value || "Other");
}

function aiErrorMessage(error) {
  const raw = error?.data?.error || error?.message || String(error || "Analysis failed");
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || parsed?.message || parsed?.error || raw;
  } catch {
    return raw;
  }
}

function normalizeAnalysis(raw) {
  const parsed = raw?.response ?? raw;
  if (!parsed?.summary || !parsed?.telemetry_findings?.length || !parsed?.mechanical_findings?.length) {
    throw new Error("AI returned an incomplete body exploration analysis. Please try again.");
  }
  return parsed;
}

function telemetrySummary(rows, exploration) {
  if (!rows.length) return null;
  const hrs = rows.map((row) => Number(row.hr)).filter(Number.isFinite);
  const duration = Math.max(...rows.map((row) => Number(row.time_offset_s) || 0));
  return {
    total_points: rows.length,
    duration_s: Math.round(duration),
    hr_min: hrs.length ? Math.round(Math.min(...hrs)) : null,
    hr_max: hrs.length ? Math.round(Math.max(...hrs)) : exploration.max_hr || null,
    hr_avg: exploration.avg_hr || null,
  };
}

export default function BodyExplorationAIPanel({ exploration, timelineRows, emgRows, userProfile }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(exploration.ai_body_exploration || null);
  const [error, setError] = useState("");

  const analyze = async () => {
    setLoading(true);
    setError("");
    try {
      const sortedRows = [...timelineRows].sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));
      const nearestHr = (timeS) => {
        if (!sortedRows.length) return null;
        return sortedRows.reduce((best, row) => {
          const dist = Math.abs(Number(row.time_offset_s) - Number(timeS || 0));
          return dist < best.dist ? { dist, row } : best;
        }, { dist: Number.POSITIVE_INFINITY, row: sortedRows[0] }).row?.hr;
      };
      const events = (exploration.event_timeline || []).map((event) => {
        const labels = (Array.isArray(event.category) ? event.category : [event.category].filter(Boolean))
          .map(categoryLabel)
          .join("+");
        const hr = nearestHr(event.time_s);
        return `[${Math.floor(Number(event.time_s || 0) / 60)}:${String(Math.round(Number(event.time_s || 0) % 60)).padStart(2, "0")}] ${labels || "Observation"} - ${event.note}${hr != null ? ` [heart rate ${Math.round(Number(hr))} beats per minute]` : ""}`;
      });
      const groundingContext = buildAIGroundingContext(userProfile);
      const raw = await base44.integrations.Core.InvokeLLM({
        model: "claude_sonnet_4_6",
        max_tokens: 6000,
        prompt: `You are a warm, careful physiological analyst reviewing a BODY EXPLORATION / INSTRUMENTATION record.

This record is not a climax-oriented masturbation session. Do not force pre-climax, climax, ejaculation, recovery, arousal-score, or orgasm framing onto it unless the person explicitly logged relevant language in the exploration record.

Focus on:
- what the body and telemetry did during exploration or instrumentation
- comfort, discomfort, tolerance, and repeated observed findings
- device interaction, fit, pressure, movement, or positioning when logged
- useful next-review notes grounded in the actual record

${groundingContext}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}

STYLE:
- Write directly to the person using "you" and "your".
- Keep the tone useful, calm, personalized, and data-grounded.
- Use paragraphs that read naturally aloud.
- Spell out measurements and numbers in natural spoken prose where practical.
- Do not invent anatomy, mechanisms, intent, goals, risk, or findings not present in the record.

BODY EXPLORATION RECORD:
${JSON.stringify({
  date: exploration.date?.slice(0, 10),
  start_time: exploration.start_time,
  duration_minutes: exploration.duration_minutes,
  exploration_type: exploration.exploration_type,
  methods: exploration.methods,
  focus_areas: exploration.focus_areas,
  purpose: exploration.purpose,
  devices: exploration.devices,
  foley_size: exploration.foley_size,
  foley_type: exploration.foley_type,
  sounding_notes: exploration.sounding_notes,
  comfort_notes: exploration.comfort_notes,
  findings: exploration.findings,
  notes: exploration.notes,
  unusual_sensations: exploration.unusual_sensations,
  tags: exploration.tags,
  heart_rate: telemetrySummary(timelineRows, exploration),
  emg_rows: emgRows.length,
}, null, 2)}

${events.length ? `TIMESTAMPED NOTES:\n${events.join("\n")}` : "No timestamped notes were recorded."}`,
        response_json_schema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            telemetry_findings: { type: "array", items: { type: "string" } },
            mechanical_findings: { type: "array", items: { type: "string" } },
            comfort_safety_findings: { type: "array", items: { type: "string" } },
            recommendations: { type: "array", items: { type: "string" } },
          },
          required: ["summary", "telemetry_findings", "mechanical_findings", "comfort_safety_findings", "recommendations"],
        },
      });
      const parsed = normalizeAnalysis(raw);
      setResult(parsed);
      await base44.entities.BodyExploration.update(exploration.id, { ai_body_exploration: parsed });
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const paragraphs = result
    ? [result.summary, ...SECTION_DEFS.flatMap((section) => result[section.key] || [])].filter(Boolean)
    : [];
  const paragraphMeta = result
    ? [{ type: "summary" }, ...SECTION_DEFS.flatMap((section) => (result[section.key] || []).map(() => ({ type: "section", section })))]
    : [];

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
            <Brain className="h-4 w-4" /> AI Body Exploration Analysis
          </h3>
          {!result && <p className="mt-1 text-xs text-muted-foreground">Useful feedback and findings for exploration, instrumentation, telemetry, and comfort observations.</p>}
        </div>
        <Button size="sm" onClick={analyze} disabled={loading} className="h-8 gap-1.5 text-xs">
          {loading ? <><span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />Analyzing</> : <><Brain className="h-3 w-3" />{result ? "Re-analyze" : "Analyze"}</>}
        </Button>
      </div>
      {error && (
        <div className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {result && (
        <TTSReader
          sessionId={`body-exploration-${exploration.id}`}
          title="AI Body Exploration Analysis"
          sessionDate={exploration.date}
          paragraphs={paragraphs}
          renderParagraph={(text, index, isActive) => {
            const meta = paragraphMeta[index];
            if (meta?.type === "summary") {
              return <p className={`rounded-r-md border-l-2 border-primary py-1 pl-3 text-base font-medium leading-relaxed ${isActive ? "bg-primary/10" : ""}`}>{text}</p>;
            }
            const section = meta?.section;
            const isFirst = paragraphMeta.findIndex((item) => item.section?.key === section?.key) === index;
            return (
              <div>
                {isFirst && <p className="mb-1.5 mt-3 flex items-center gap-1.5 border-t border-border pt-2 text-xs font-semibold" style={{ color: section.color }}>{section.icon}{section.label}</p>}
                <p className={`rounded-r-md border-l-2 py-1 pl-3 text-sm leading-relaxed ${isActive ? "bg-muted/50" : ""}`} style={{ borderColor: section.color }}>{text}</p>
              </div>
            );
          }}
        />
      )}
    </div>
  );
}
