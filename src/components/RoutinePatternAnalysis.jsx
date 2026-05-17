import { useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Brain, TrendingUp, Award, Lightbulb, Activity, Zap, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

// Compute average of an array, or null if empty
function avg(arr) {
  const valid = arr.filter((v) => v != null && !isNaN(v));
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

// Get sorted combination key for a session's methods
function methodKey(session) {
  return (session.methods || []).slice().sort().join(" + ") || "Unknown";
}

// Analyze sessions into routine groups
function analyzeRoutines(sessions) {
  // Group by method combination
  const methodGroups = {};
  const buildGroups = {};

  for (const s of sessions) {
    const mk = methodKey(s);
    if (!methodGroups[mk]) methodGroups[mk] = [];
    methodGroups[mk].push(s);

    if (s.build_type) {
      if (!buildGroups[s.build_type]) buildGroups[s.build_type] = [];
      buildGroups[s.build_type].push(s);
    }
  }

  const toStats = (groups, minCount = 2) =>
    Object.entries(groups)
      .filter(([, arr]) => arr.length >= minCount)
      .map(([key, arr]) => ({
        key,
        count: arr.length,
        avgSatisfaction: avg(arr.map((s) => s.satisfaction)),
        avgBuildQuality: avg(arr.map((s) => s.build_quality)),
        avgIntensity: avg(arr.map((s) => s.intensity)),
        composite: avg([
          avg(arr.map((s) => s.satisfaction)),
          avg(arr.map((s) => s.build_quality)),
        ]),
      }))
      .sort((a, b) => (b.composite ?? 0) - (a.composite ?? 0));

  return {
    methods: toStats(methodGroups, 2),
    buildTypes: toStats(buildGroups, 2),
  };
}

const BAR_COLORS = ["hsl(var(--chart-1))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", "hsl(var(--chart-4))", "hsl(var(--chart-5))"];

function StatBar({ data, dataKey, label }) {
  if (!data.length) return null;
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</p>
      <div style={{ height: Math.max(120, data.length * 36) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 32, bottom: 0, left: 0 }}>
            <XAxis type="number" domain={[0, 10]} tick={{ fontSize: 9 }} />
            <YAxis
              type="category"
              dataKey="key"
              tick={{ fontSize: 9 }}
              width={120}
              tickFormatter={(v) => v.length > 18 ? v.slice(0, 17) + "…" : v}
            />
            <Tooltip
              formatter={(val, name) => [val ? val.toFixed(1) : "—", name]}
              contentStyle={{ fontSize: 11 }}
            />
            <Bar dataKey={dataKey} radius={[0, 4, 4, 0]}>
              {data.map((_, i) => <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="space-y-1 mt-1">
        {data.map((d, i) => (
          <div key={d.key} className="flex items-center gap-2 text-[10px]">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: BAR_COLORS[i % BAR_COLORS.length] }} />
            <span className="font-medium truncate flex-1" title={d.key}>{d.key}</span>
            <span className="text-muted-foreground shrink-0">{d.count} sessions</span>
            {d[dataKey] != null && <span className="font-mono font-bold shrink-0">{d[dataKey].toFixed(1)}/10</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function RoutinePatternAnalysis({ sessions }) {
  const [aiResult, setAiResult] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const stats = useMemo(() => analyzeRoutines(sessions), [sessions]);

  const runAI = async () => {
    setAiLoading(true);
    try {
      // Build richer context from sessions
      const recentSessions = sessions.slice(0, 30);
      const overallAvgSat = avg(sessions.map(s => s.satisfaction));
      const overallAvgBQ = avg(sessions.map(s => s.build_quality));
      const totalSessions = sessions.length;

      const res = await base44.integrations.Core.InvokeLLM({
        model: "claude_sonnet_4_6",
        prompt: `You are an expert physiological data analyst. Analyze these personal session statistics to provide deep, specific, actionable insights.

DATASET OVERVIEW:
- Total sessions: ${totalSessions}
- Overall avg satisfaction: ${overallAvgSat?.toFixed(2)}/10
- Overall avg build quality: ${overallAvgBQ?.toFixed(2)}/10

METHOD COMBINATION STATS (sorted by composite score):
${JSON.stringify(stats.methods.map(m => ({
  routine: m.key,
  sessions: m.count,
  avg_satisfaction: m.avgSatisfaction?.toFixed(2),
  avg_build_quality: m.avgBuildQuality?.toFixed(2),
  avg_intensity: m.avgIntensity?.toFixed(2),
  vs_overall_satisfaction: m.avgSatisfaction != null && overallAvgSat != null ? (m.avgSatisfaction - overallAvgSat).toFixed(2) : null,
})), null, 2)}

BUILD TYPE STATS (sorted by composite score):
${JSON.stringify(stats.buildTypes.map(b => ({
  build_type: b.key,
  sessions: b.count,
  avg_satisfaction: b.avgSatisfaction?.toFixed(2),
  avg_build_quality: b.avgBuildQuality?.toFixed(2),
  vs_overall_satisfaction: b.avgSatisfaction != null && overallAvgSat != null ? (b.avgSatisfaction - overallAvgSat).toFixed(2) : null,
})), null, 2)}

RECENT SESSION CONTEXT (last ${recentSessions.length} sessions — mood, hydration, methods used):
${recentSessions.map(s => `  ${s.date?.slice(0,10)} | methods: ${(s.methods||[]).join('+')||'?'} | build: ${s.build_type||'?'} | sat: ${s.satisfaction??'?'} | bq: ${s.build_quality??'?'} | mood: ${s.mood||'?'} | hydration: ${s.hydration||'?'}`).join('\n')}

Provide a thorough, data-driven analysis covering:
1. The single best-performing routine and WHY it outperforms (cite exact numbers)
2. Key pattern insights comparing top vs bottom performers
3. Build type impact analysis — which build type correlates with the best outcomes
4. Contextual factors (mood, hydration) — any correlations you can infer from the recent session log
5. 2–3 specific, actionable recommendations to optimize future sessions

Be direct, specific, and cite numbers. Flag if sample sizes are too small to draw conclusions.`,
        response_json_schema: {
          type: "object",
          properties: {
            top_routine: { type: "string", description: "Name of the top performing routine with its key metrics" },
            top_routine_reason: { type: "string", description: "1-2 sentence explanation of why this routine leads" },
            pattern_insights: { type: "array", items: { type: "string" }, description: "3-5 data-driven observations comparing routines" },
            build_type_analysis: { type: "array", items: { type: "string" }, description: "2-3 insights about how build type affects outcomes" },
            contextual_factors: { type: "array", items: { type: "string" }, description: "1-3 observations about mood/hydration/context correlations" },
            recommendations: { type: "array", items: { type: "string" }, description: "2-3 concrete, actionable next steps" },
          },
          required: ["top_routine", "top_routine_reason", "pattern_insights", "build_type_analysis", "recommendations"],
        },
      });
      const raw = typeof res === "string" ? JSON.parse(res) : res;
      setAiResult(raw?.response ?? raw);
    } finally {
      setAiLoading(false);
    }
  };

  if (sessions.length < 3) return null;

  const hasData = stats.methods.length > 0 || stats.buildTypes.length > 0;
  if (!hasData) return null;

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Award className="w-4 h-4 text-primary" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Routine Performance Patterns</h3>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[10px] text-primary font-semibold"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>

      {!expanded && (
        <div className="space-y-1">
          {stats.methods.slice(0, 3).map((m, i) => (
            <div key={m.key} className="flex items-center gap-2 text-xs">
              <span className="w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold text-white shrink-0" style={{ background: BAR_COLORS[i] }}>
                {i + 1}
              </span>
              <span className="flex-1 truncate font-medium" title={m.key}>{m.key}</span>
              <span className="text-muted-foreground shrink-0 text-[10px]">{m.count}×</span>
              {m.avgSatisfaction != null && (
                <span className="font-mono text-[10px] text-primary font-bold shrink-0">Sat {m.avgSatisfaction.toFixed(1)}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {expanded && (
        <div className="space-y-5">
          {stats.methods.length > 0 && (
            <StatBar data={stats.methods} dataKey="avgSatisfaction" label="Method Combinations — Avg Satisfaction" />
          )}
          {stats.methods.length > 0 && (
            <StatBar data={stats.methods} dataKey="avgBuildQuality" label="Method Combinations — Avg Build Quality" />
          )}
          {stats.buildTypes.length > 0 && (
            <StatBar data={stats.buildTypes} dataKey="avgSatisfaction" label="Build Types — Avg Satisfaction" />
          )}

          <div className="border-t border-border pt-3 space-y-3">
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                <Brain className="w-3.5 h-3.5" /> AI Pattern Insights
              </p>
              <Button size="sm" className="h-7 text-xs gap-1.5" onClick={runAI} disabled={aiLoading}>
                {aiLoading
                  ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</>
                  : <><Brain className="w-3 h-3" />Analyze</>}
              </Button>
            </div>
            {aiResult && (
              <div className="space-y-4">
                {/* Top Routine */}
                {aiResult.top_routine && (
                  <div className="bg-primary/10 rounded-lg p-3 space-y-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-primary flex items-center gap-1">
                      <Award className="w-3 h-3" /> Top Performing Routine
                    </p>
                    <p className="text-sm font-bold text-primary">{aiResult.top_routine}</p>
                    {aiResult.top_routine_reason && (
                      <p className="text-xs text-foreground/80 leading-relaxed">{aiResult.top_routine_reason}</p>
                    )}
                  </div>
                )}

                {/* Pattern Insights */}
                {aiResult.pattern_insights?.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-chart-1 flex items-center gap-1">
                      <TrendingUp className="w-3 h-3" /> Pattern Insights
                    </p>
                    {aiResult.pattern_insights.map((ins, i) => (
                      <div key={i} className="flex gap-2 text-sm text-foreground/90 pl-1 border-l-2 border-chart-1/40 py-0.5">
                        <span className="leading-relaxed">{ins}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Build Type Analysis */}
                {aiResult.build_type_analysis?.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-chart-2 flex items-center gap-1">
                      <Activity className="w-3 h-3" /> Build Type Analysis
                    </p>
                    {aiResult.build_type_analysis.map((ins, i) => (
                      <div key={i} className="flex gap-2 text-sm text-foreground/90 pl-1 border-l-2 border-chart-2/40 py-0.5">
                        <span className="leading-relaxed">{ins}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Contextual Factors */}
                {aiResult.contextual_factors?.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-chart-4 flex items-center gap-1">
                      <Zap className="w-3 h-3" /> Contextual Factors
                    </p>
                    {aiResult.contextual_factors.map((ins, i) => (
                      <div key={i} className="flex gap-2 text-sm text-foreground/90 pl-1 border-l-2 border-chart-4/40 py-0.5">
                        <span className="leading-relaxed">{ins}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Recommendations */}
                {aiResult.recommendations?.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-accent flex items-center gap-1">
                      <Lightbulb className="w-3 h-3" /> Recommendations
                    </p>
                    {aiResult.recommendations.map((rec, i) => (
                      <div key={i} className="flex gap-2 text-sm text-foreground/90 pl-1 border-l-2 border-accent/40 py-0.5">
                        <span className="leading-relaxed">{rec}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!aiResult && !aiLoading && (
              <p className="text-xs text-muted-foreground">Click Analyze for deep AI-powered insights on patterns, build types, contextual factors, and personalized recommendations. Uses Claude Sonnet.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}