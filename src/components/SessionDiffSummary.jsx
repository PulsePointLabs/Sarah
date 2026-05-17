import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Sparkles, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import moment from "moment";

function fmtSec(v) {
  if (v == null) return null;
  const total = Math.round(Number(v));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function DiffRow({ label, a, b }) {
  const changed = a !== b && a != null && b != null;
  return (
    <div className={`grid grid-cols-[1fr_2fr_2fr] gap-2 items-start py-2 border-b border-border last:border-0 ${changed ? "" : "opacity-60"}`}>
      <span className="text-[10px] text-muted-foreground uppercase font-semibold pt-0.5">{label}</span>
      <span className={`text-xs px-2 py-1 rounded-md ${changed ? "bg-chart-3/10 text-chart-3 font-medium" : "text-foreground/70"}`}>{a ?? "—"}</span>
      <span className={`text-xs px-2 py-1 rounded-md ${changed ? "bg-chart-2/10 text-chart-2 font-medium" : "text-foreground/70"}`}>{b ?? "—"}</span>
    </div>
  );
}

export default function SessionDiffSummary({ sessionA, sessionB }) {
  const [open, setOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);

  const labelA = moment(sessionA.date).format("M/D/YY");
  const labelB = moment(sessionB.date).format("M/D/YY");

  // Build diff rows data
  const methodsA = (sessionA.methods || []).join(", ") || null;
  const methodsB = (sessionB.methods || []).join(", ") || null;

  const recA = sessionA.recovery_offset_s != null && sessionA.climax_offset_s != null
    ? fmtSec(sessionA.recovery_offset_s - sessionA.climax_offset_s) : null;
  const recB = sessionB.recovery_offset_s != null && sessionB.climax_offset_s != null
    ? fmtSec(sessionB.recovery_offset_s - sessionB.climax_offset_s) : null;

  const buildA = sessionA.pre_climax_offset_s != null && sessionA.climax_offset_s != null
    ? fmtSec(Math.abs(sessionA.climax_offset_s - sessionA.pre_climax_offset_s)) : null;
  const buildB = sessionB.pre_climax_offset_s != null && sessionB.climax_offset_s != null
    ? fmtSec(Math.abs(sessionB.climax_offset_s - sessionB.pre_climax_offset_s)) : null;

  const generate = async () => {
    setLoading(true);
    setSummary(null);

    const fmt = (s) => ({
      date: moment(s.date).format("MMMM D, YYYY"),
      duration: s.duration_minutes ? `${s.duration_minutes} minutes` : null,
      methods: s.methods,
      foley: s.foley_size ? `${s.foley_size}Fr ${s.foley_type || ""}`.trim() : null,
      estim_notes: s.estim_notes || null,
      intensity: s.intensity,
      build_quality: s.build_quality,
      satisfaction: s.satisfaction,
      build_type: s.build_type,
      climax_duration: s.climax_duration,
      no_climax: s.no_climax || false,
      max_hr: s.max_hr,
      hr_at_climax: s.hr_at_climax,
      hr_avg_at_climax_window: s.hr_avg_at_climax_window,
      build_to_climax_s: sessionA === s
        ? (sessionA.pre_climax_offset_s != null && sessionA.climax_offset_s != null ? Math.round(Math.abs(sessionA.climax_offset_s - sessionA.pre_climax_offset_s)) : null)
        : (sessionB.pre_climax_offset_s != null && sessionB.climax_offset_s != null ? Math.round(Math.abs(sessionB.climax_offset_s - sessionB.pre_climax_offset_s)) : null),
      recovery_after_climax_s: sessionA === s
        ? (sessionA.recovery_offset_s != null && sessionA.climax_offset_s != null ? Math.round(sessionA.recovery_offset_s - sessionA.climax_offset_s) : null)
        : (sessionB.recovery_offset_s != null && sessionB.climax_offset_s != null ? Math.round(sessionB.recovery_offset_s - sessionB.climax_offset_s) : null),
      mood: s.mood,
      ejaculate_volume: s.ejaculate_volume || null,
      unusual_sensations: s.unusual_sensations || null,
      notes: s.notes || null,
    });

    const res = await base44.integrations.Core.InvokeLLM({
      model: "claude_sonnet_4_6",
      prompt: `You are a specialist in sexual physiology and stimulation response. Compare these two sessions and write a focused 3-paragraph summary for the person.

Paragraph 1 — STIMULATION METHODS: What was different about the techniques, equipment, or combinations used? How might those differences explain what happened?

Paragraph 2 — PEAK AROUSAL QUALITY: Compare the intensity, build quality, satisfaction scores, HR at climax, and climax duration. Which session produced a stronger or more satisfying peak, and what seems to have driven that?

Paragraph 3 — RECOVERY TIME: Compare the time from climax to recovery. If one session recovered faster or slower, what could explain that — the intensity of the peak, the methods used, the build duration?

Rules:
- Write directly to the person using "you" and "your"
- Be specific — reference actual values and method names from the data
- Plain prose, no bullet points, no markdown, no headers
- Keep it concise: 2–4 sentences per paragraph

Session A (${labelA}):
${JSON.stringify(fmt(sessionA), null, 2)}

Session B (${labelB}):
${JSON.stringify(fmt(sessionB), null, 2)}`,
      response_json_schema: {
        type: "object",
        properties: {
          stimulation_methods: { type: "string" },
          peak_arousal_quality: { type: "string" },
          recovery_time: { type: "string" },
        },
        required: ["stimulation_methods", "peak_arousal_quality", "recovery_time"],
      },
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    setSummary(raw?.response ?? raw);
    setLoading(false);
  };

  const sections = summary ? [
    { label: "Stimulation Methods", key: "stimulation_methods", color: "hsl(var(--chart-2))" },
    { label: "Peak Arousal Quality", key: "peak_arousal_quality", color: "hsl(var(--primary))" },
    { label: "Recovery Time", key: "recovery_time", color: "hsl(var(--chart-5))" },
  ] : [];

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      {/* Header */}
      <button
        className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-accent">
          <Sparkles className="w-4 h-4" /> Session Diff Summary
        </span>
        <span className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">{labelA} vs {labelB}</span>
          {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </span>
      </button>

      {open && (
        <div className="p-4 space-y-4">
          {/* Column headers */}
          <div className="grid grid-cols-[1fr_2fr_2fr] gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground pb-1 border-b border-border">
            <span />
            <span className="text-chart-3">{labelA}</span>
            <span className="text-chart-2">{labelB}</span>
          </div>

          {/* Key diff rows */}
          <div>
            <DiffRow label="Methods" a={methodsA} b={methodsB} />
            <DiffRow label="Intensity" a={sessionA.intensity != null ? `${sessionA.intensity}/10` : null} b={sessionB.intensity != null ? `${sessionB.intensity}/10` : null} />
            <DiffRow label="Build Quality" a={sessionA.build_quality != null ? `${sessionA.build_quality}/10` : null} b={sessionB.build_quality != null ? `${sessionB.build_quality}/10` : null} />
            <DiffRow label="Satisfaction" a={sessionA.satisfaction != null ? `${sessionA.satisfaction}/10` : null} b={sessionB.satisfaction != null ? `${sessionB.satisfaction}/10` : null} />
            <DiffRow label="Max HR" a={sessionA.max_hr != null ? `${sessionA.max_hr} bpm` : null} b={sessionB.max_hr != null ? `${sessionB.max_hr} bpm` : null} />
            <DiffRow label="HR@Climax" a={sessionA.hr_at_climax != null ? `${sessionA.hr_at_climax} bpm` : null} b={sessionB.hr_at_climax != null ? `${sessionB.hr_at_climax} bpm` : null} />
            <DiffRow label="Build→Climax" a={buildA} b={buildB} />
            <DiffRow label="Recovery" a={recA} b={recB} />
            <DiffRow label="Climax Duration" a={sessionA.climax_duration} b={sessionB.climax_duration} />
            <DiffRow label="Build Type" a={sessionA.build_type} b={sessionB.build_type} />
          </div>

          {/* AI Summary */}
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">AI Analysis</span>
              <Button size="sm" variant="outline" onClick={generate} disabled={loading} className="h-7 text-xs gap-1.5">
                {loading
                  ? <><span className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />Analyzing…</>
                  : summary
                  ? <><RefreshCw className="w-3 h-3" />Refresh</>
                  : <><Sparkles className="w-3 h-3" />Generate Summary</>}
              </Button>
            </div>

            {!summary && !loading && (
              <p className="text-xs text-muted-foreground">
                Click "Generate Summary" for an AI breakdown of what differed in stimulation, peak arousal, and recovery between these two sessions.
              </p>
            )}

            {loading && (
              <p className="text-xs text-muted-foreground animate-pulse">Comparing sessions…</p>
            )}

            {summary && sections.map(({ label, key, color }) => (
              <div
                key={key}
                className="pl-3 border-l-2 py-2 rounded-r-md"
                style={{ borderColor: color, background: color + "12" }}
              >
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color }}>{label}</p>
                <p className="text-sm leading-relaxed text-foreground">{summary[key]}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}