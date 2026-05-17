import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Brain, Lightbulb, TrendingUp, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import TTSReader from "./TTSReader";

const OUTCOME_LABELS = {
  intensity: "Intensity",
  satisfaction: "Satisfaction",
  build_quality: "Build Quality",
};

export default function EventCorrelationAI({ sessions, correlationData, selectedOutcome }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const analyze = async () => {
    setLoading(true);
    setResult(null);

    // Summarize method usage × outcome
    const methodOutcomes = {};
    sessions.forEach((s) => {
      const outcome = s[selectedOutcome];
      if (outcome == null) return;
      (s.methods || []).forEach((m) => {
        if (!methodOutcomes[m]) methodOutcomes[m] = [];
        methodOutcomes[m].push(outcome);
      });
    });
    const methodSummary = Object.entries(methodOutcomes)
      .map(([m, scores]) => ({
        method: m,
        avgOutcome: +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2),
        count: scores.length,
      }))
      .sort((a, b) => b.avgOutcome - a.avgOutcome);

    // Build correlation summary string
    const corrSummary = correlationData
      .slice(0, 10)
      .map((d) => `- ${d.label}: avg ${OUTCOME_LABELS[selectedOutcome]} WITH = ${d.avgWith}, WITHOUT = ${d.avgWithout} (Δ ${d.delta > 0 ? "+" : ""}${d.delta}, n=${d.sessionCount})`)
      .join("\n");

    // Build-type breakdown
    const buildOutcomes = {};
    sessions.forEach((s) => {
      const outcome = s[selectedOutcome];
      if (!s.build_type || outcome == null) return;
      if (!buildOutcomes[s.build_type]) buildOutcomes[s.build_type] = [];
      buildOutcomes[s.build_type].push(outcome);
    });
    const buildSummary = Object.entries(buildOutcomes)
      .map(([bt, scores]) => `${bt}: avg ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)} (n=${scores.length})`)
      .join(", ");

    // Mood breakdown
    const moodOutcomes = {};
    sessions.forEach((s) => {
      const outcome = s[selectedOutcome];
      if (!s.mood || outcome == null) return;
      if (!moodOutcomes[s.mood]) moodOutcomes[s.mood] = [];
      moodOutcomes[s.mood].push(outcome);
    });
    const moodSummary = Object.entries(moodOutcomes)
      .map(([mood, scores]) => `${mood}: ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)}`)
      .join(", ");

    const res = await base44.integrations.Core.InvokeLLM({
      model: "claude_sonnet_4_6",
      prompt: `You are an expert physiological data analyst. Analyze cross-session correlations between event categories, session methods, and contextual factors against the outcome metric "${OUTCOME_LABELS[selectedOutcome]}" (scale 1–10).

DATA SUMMARY:
- Total sessions analyzed: ${sessions.length}
- Sessions with event timeline data: ${sessions.filter((s) => (s.event_timeline || []).length > 0).length}
- Outcome metric: ${OUTCOME_LABELS[selectedOutcome]}

EVENT CATEGORY CORRELATIONS (avg ${OUTCOME_LABELS[selectedOutcome]} with vs. without each category):
${corrSummary || "No correlation data available"}

METHOD × OUTCOME:
${methodSummary.map((m) => `- ${m.method}: avg ${m.avgOutcome} (n=${m.count})`).join("\n")}

BUILD TYPE × OUTCOME:
${buildSummary || "No build type data"}

MOOD × OUTCOME:
${moodSummary || "No mood data"}

Provide a detailed, actionable analysis:
1. Which event categories show the strongest positive and negative associations with ${OUTCOME_LABELS[selectedOutcome]}?
2. What patterns emerge from the method and contextual data?
3. What specific behavioral or setup recommendations can you make based on these correlations?
4. Are there any surprising or counterintuitive findings worth noting?
5. What additional data would strengthen these insights?

Be specific, reference the actual numbers, and provide practical takeaways the user can apply in future sessions.`,
      response_json_schema: {
        type: "object",
        properties: {
          key_correlations: { type: "array", items: { type: "string" } },
          patterns: { type: "array", items: { type: "string" } },
          recommendations: { type: "array", items: { type: "string" } },
          surprising_findings: { type: "array", items: { type: "string" } },
          data_gaps: { type: "array", items: { type: "string" } },
        },
        required: ["key_correlations", "patterns", "recommendations"],
      },
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    setResult(raw?.response ?? raw);
    setLoading(false);
  };

  const sections = result ? [
    { key: "key_correlations", label: "Key Correlations", icon: <TrendingUp className="w-3.5 h-3.5" />, color: "hsl(var(--primary))" },
    { key: "patterns", label: "Patterns", icon: <Brain className="w-3.5 h-3.5" />, color: "hsl(var(--chart-2))" },
    { key: "recommendations", label: "Recommendations", icon: <Lightbulb className="w-3.5 h-3.5" />, color: "hsl(var(--accent))" },
    { key: "surprising_findings", label: "Surprising Findings", icon: <AlertCircle className="w-3.5 h-3.5" />, color: "hsl(var(--chart-4))" },
    { key: "data_gaps", label: "Data Gaps", icon: null, color: "hsl(var(--muted-foreground))" },
  ] : [];

  const paragraphs = result
    ? sections.flatMap((sec) => (result[sec.key] || []))
    : [];

  // Build index → section mapping for renderParagraph
  const sectionMap = result
    ? sections.flatMap((sec) => (result[sec.key] || []).map(() => sec))
    : [];

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
          <Brain className="w-4 h-4" /> AI Correlation Analysis
        </h3>
        <Button size="sm" onClick={analyze} disabled={loading} className="h-7 text-xs gap-1.5">
          {loading
            ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</>
            : <><Brain className="w-3 h-3" />Analyze</>}
        </Button>
      </div>

      {!result && !loading && (
        <p className="text-xs text-muted-foreground">
          Click Analyze for a deep AI interpretation of the correlation patterns above. Uses Claude Sonnet.
        </p>
      )}

      {result && (
        <TTSReader
          paragraphs={paragraphs}
          renderParagraph={(text, idx, isActive) => {
            const sec = sectionMap[idx];
            return (
              <li
                className={`text-sm leading-relaxed pl-3 border-l-2 py-1 transition-all duration-200 rounded-r-md list-none ${
                  isActive ? "bg-primary/8 font-medium text-foreground border-primary" : "text-foreground border-primary/30"
                }`}
              >
                {text}
              </li>
            );
          }}
        />
      )}

      {result && sections.map((sec) =>
        (result[sec.key] || []).length > 0 ? (
          <div key={sec.key} className="bg-muted/50 rounded-lg p-3 space-y-1.5">
            <p className="text-xs font-semibold flex items-center gap-1.5" style={{ color: sec.color }}>
              {sec.icon}{sec.label}
            </p>
            <ul className="space-y-1">
              {result[sec.key].map((item, i) => (
                <li key={i} className="text-sm text-foreground pl-3 border-l-2 border-primary/30 leading-relaxed py-0.5">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ) : null
      )}
    </div>
  );
}