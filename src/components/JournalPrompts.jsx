import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Sparkles, ChevronDown, ChevronUp, MessageCircle, X } from "lucide-react";

/**
 * Analyses the session's HR data + session metadata to detect anomalies and
 * missing context, then generates targeted qualitative reflection prompts via
 * the LLM. Shown collapsed by default; each prompt is tappable to insert it
 * into the journal textarea.
 */
export default function JournalPrompts({ session, timelineRows = [], onInsertPrompt }) {
  const [prompts, setPrompts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [dismissed, setDismissed] = useState([]);
  const [generated, setGenerated] = useState(false);

  // Auto-generate prompts once when the component mounts (if HR data is available)
  useEffect(() => {
    if (generated) return;
    if (timelineRows.length === 0 && !session.avg_hr) return; // nothing to analyse
    generatePrompts();
  }, [timelineRows.length]);

  const generatePrompts = async () => {
    setLoading(true);
    setGenerated(true);

    // ── Compute HR anomalies locally ──────────────────────────────────────────
    const sortedRows = [...timelineRows].sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));
    const hrVals = sortedRows.map((r) => Number(r.hr));

    // Sudden spikes: consecutive diff > 20 bpm
    const spikes = [];
    for (let i = 1; i < sortedRows.length; i++) {
      const diff = hrVals[i] - hrVals[i - 1];
      if (diff > 20) {
        spikes.push({ time_s: Number(sortedRows[i].time_offset_s), rise: Math.round(diff), hr: Math.round(hrVals[i]) });
      }
    }

    // Plateaus: HR within ±4 bpm for >60s
    const plateaus = [];
    let pStart = null; let pHR = null;
    for (let i = 0; i < sortedRows.length; i++) {
      const hr = hrVals[i]; const t = Number(sortedRows[i].time_offset_s);
      if (pStart == null) { pStart = t; pHR = hr; continue; }
      if (Math.abs(hr - pHR) <= 4) {
        if (t - pStart >= 60 && !plateaus.find((p) => Math.abs(p.start_s - pStart) < 30)) {
          plateaus.push({ start_s: Math.round(pStart), duration_s: Math.round(t - pStart), avg_hr: Math.round(pHR) });
        }
      } else { pStart = t; pHR = hr; }
    }

    // Sharp drops after climax (recovery)
    let sharpDrop = null;
    if (session.climax_offset_s != null) {
      const postClimax = sortedRows.filter((r) => Number(r.time_offset_s) >= session.climax_offset_s && Number(r.time_offset_s) <= session.climax_offset_s + 120);
      if (postClimax.length >= 2) {
        const drop = Number(postClimax[0].hr) - Number(postClimax[postClimax.length - 1].hr);
        const dt = Number(postClimax[postClimax.length - 1].time_offset_s) - Number(postClimax[0].time_offset_s);
        if (drop > 20 && dt > 0) sharpDrop = { drop_bpm: Math.round(drop), over_s: Math.round(dt) };
      }
    }

    // Missing event context: events with very short notes (< 15 chars) or no notes
    const skimpyEvents = (session.event_timeline || []).filter((e) => !e.note || e.note.trim().length < 15);

    // Gaps in event logging (>5min with no events but notable HR changes)
    const eventGaps = [];
    if (session.duration_minutes && sortedRows.length > 0) {
      const totalS = session.duration_minutes * 60;
      const eventTimes = (session.event_timeline || []).map((e) => e.time_s).sort((a, b) => a - b);
      const checkPoints = [0, ...eventTimes, totalS];
      for (let i = 0; i < checkPoints.length - 1; i++) {
        const gap = checkPoints[i + 1] - checkPoints[i];
        if (gap > 300) {
          // Check if HR changed notably in this gap
          const gapRows = sortedRows.filter((r) => Number(r.time_offset_s) >= checkPoints[i] && Number(r.time_offset_s) <= checkPoints[i + 1]);
          const gapHRs = gapRows.map((r) => Number(r.hr));
          if (gapHRs.length > 1) {
            const range = Math.max(...gapHRs) - Math.min(...gapHRs);
            if (range > 15) eventGaps.push({ start_s: Math.round(checkPoints[i]), end_s: Math.round(checkPoints[i + 1]), hr_range: Math.round(range) });
          }
        }
      }
    }

    const fmtT = (s) => { const m = Math.floor(s / 60); const sec = Math.round(s % 60); return `${m}:${sec.toString().padStart(2, "0")}`; };

    const anomalySummary = [
      spikes.slice(0, 3).map((sp) => `HR spike of +${sp.rise} bpm to ${sp.hr} bpm at ${fmtT(sp.time_s)}`).join("; "),
      plateaus.slice(0, 2).map((p) => `HR plateau at ~${p.avg_hr} bpm for ${Math.round(p.duration_s / 60)} min starting at ${fmtT(p.start_s)}`).join("; "),
      sharpDrop ? `Sharp HR drop of ${sharpDrop.drop_bpm} bpm over ${sharpDrop.over_s}s post-climax` : "",
      skimpyEvents.length ? `${skimpyEvents.length} logged events had very short or missing notes` : "",
      eventGaps.slice(0, 2).map((g) => `${Math.round((g.end_s - g.start_s) / 60)}-min gap with ${g.hr_range} bpm HR variation (${fmtT(g.start_s)}–${fmtT(g.end_s)})`).join("; "),
    ].filter(Boolean).join("\n");

    if (!anomalySummary.trim()) {
      // Nothing interesting detected
      setLoading(false);
      return;
    }

    const sessionSummary = [
      `Duration: ${session.duration_minutes ?? "?"}min`,
      `Methods: ${(session.methods || []).join(", ") || "—"}`,
      `Intensity: ${session.intensity ?? "?"}/10, Satisfaction: ${session.satisfaction ?? "?"}/10`,
      session.no_climax ? "No climax this session" : `HR at climax: ${session.hr_at_climax ?? "?"}`,
      session.mood ? `Mood: ${session.mood}` : null,
      session.discomfort_entries?.length ? `Discomfort logged (${session.discomfort_entries.length} entries)` : null,
      session.unusual_sensations ? `Unusual sensations: ${session.unusual_sensations}` : null,
    ].filter(Boolean).join("; ");

    const res = await base44.integrations.Core.InvokeLLM({
      prompt: `You are a thoughtful personal journal coach helping someone reflect on an intimate session. Based on the session data and any notable physiological patterns, generate 3-5 rich, open-ended reflection prompts that invite genuine qualitative self-exploration.

CRITICAL RULES:
- Focus on AROUSAL, SENSATION, STIMULATION, and subjective experience — NOT on heart rate numbers or timestamps
- Prompts should feel like something a curious, empathetic friend might ask — warm, personal, not clinical
- Each prompt should invite a narrative answer, not a yes/no
- Reference what actually happened in the session (methods, events, outcomes) in a broad, experiential way — not pinned to exact moments
- Cover different dimensions: what was felt physically, emotionally, what surprised them, what they'd change, what lingered afterward
- Avoid phrases like "at X minutes" or "during the spike" — speak to the ARC of the experience instead
- If the session had notable moments (discomfort, unusual sensations, no climax, long plateaus), weave those in naturally as a starting point, not a clinical observation

SESSION CONTEXT: ${sessionSummary}

NOTABLE PATTERNS (use as inspiration, not as literal prompt anchors):
${anomalySummary}

Return exactly 3-5 prompts. Vary the focus: physical sensation, emotional tone, stimulation quality, something unexpected, and what they'd want to remember or change.`,
      response_json_schema: {
        type: "object",
        properties: {
          prompts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "The reflection prompt text" },
                category: { type: "string", enum: ["sensation", "emotion", "timing", "context", "comparison"], description: "Type of reflection" },
                trigger: { type: "string", description: "Short label of what anomaly/gap triggered this prompt" }
              },
              required: ["text", "category", "trigger"]
            }
          }
        },
        required: ["prompts"]
      }
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    const result = raw?.response ?? raw;
    setPrompts(result?.prompts || []);
    setLoading(false);
  };

  const visiblePrompts = prompts.filter((_, i) => !dismissed.includes(i));

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-1.5">
        <span className="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0" />
        <span className="text-xs text-muted-foreground">Analysing session for reflection prompts…</span>
      </div>
    );
  }

  if (visiblePrompts.length === 0 && !loading) return null;

  const CATEGORY_COLORS = {
    sensation: "hsl(var(--primary))",
    emotion: "hsl(var(--chart-3))",
    timing: "hsl(var(--chart-2))",
    context: "hsl(var(--chart-4))",
    comparison: "hsl(var(--accent))",
  };

  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-3 space-y-2">
      <button
        className="flex items-center gap-1.5 w-full text-left"
        onClick={() => setCollapsed((v) => !v)}
      >
        <Sparkles className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="text-xs font-semibold text-accent">Reflection Prompts</span>
        <span className="text-[10px] text-muted-foreground ml-1">({visiblePrompts.length} based on your session data)</span>
        {collapsed
          ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground ml-auto" />
          : <ChevronUp className="w-3.5 h-3.5 text-muted-foreground ml-auto" />}
      </button>

      {!collapsed && (
        <div className="space-y-2 pt-0.5">
          {visiblePrompts.map((p, i) => {
            const realIdx = prompts.indexOf(p);
            const color = CATEGORY_COLORS[p.category] || "hsl(var(--accent))";
            return (
              <div
                key={realIdx}
                className="flex items-start gap-2 rounded-lg px-3 py-2.5 border transition-colors group"
                style={{ borderColor: color + "44", background: color + "0d" }}
              >
                <MessageCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color }} />
                <div className="flex-1 min-w-0">
                  <p className="text-[9px] font-semibold uppercase tracking-wide mb-0.5" style={{ color }}>
                    {p.trigger}
                  </p>
                  <p className="text-xs text-foreground leading-relaxed">{p.text}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    className="text-[10px] text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-muted transition-colors"
                    onClick={() => onInsertPrompt?.(p.text)}
                    title="Add to notes"
                  >
                    Use
                  </button>
                  <button
                    className="text-muted-foreground hover:text-foreground p-0.5 rounded-md hover:bg-muted transition-colors"
                    onClick={() => setDismissed((d) => [...d, realIdx])}
                    title="Dismiss"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}