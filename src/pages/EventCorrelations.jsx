import { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { Brain, Sparkles, TrendingUp, BarChart2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from "recharts";
import { EVENT_CATEGORIES, normalizeCategoryArray } from "../components/session-form/EventTimelineSection";
import EventCorrelationAI from "../components/EventCorrelationAI";

const OUTCOME_LABELS = {
  intensity: "Intensity",
  satisfaction: "Satisfaction",
  build_quality: "Build Quality",
};

const OUTCOME_COLORS = {
  intensity: "hsl(var(--primary))",
  satisfaction: "hsl(var(--accent))",
  build_quality: "hsl(var(--chart-2))",
};

function getCategoryMeta(value) {
  return EVENT_CATEGORIES.find((c) => c.value === value) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg p-2 text-xs shadow-md space-y-0.5">
      <p className="font-semibold text-foreground">{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color }} className="font-mono">
          {p.name}: {typeof p.value === "number" ? p.value.toFixed(2) : p.value}
        </p>
      ))}
    </div>
  );
}

export default function EventCorrelations() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedOutcome, setSelectedOutcome] = useState("satisfaction");

  useEffect(() => {
    base44.entities.Session.list("-date", 500).then((data) => {
      setSessions(data);
      setLoading(false);
    });
  }, []);

  // --- Core correlation engine ---
  // For each event category, gather all sessions that had at least one event of that category.
  // Compare avg outcome score for those sessions vs sessions WITHOUT that category.
  const correlationData = useMemo(() => {
    if (!sessions.length) return [];

    // Build a map: categoryValue → Set of session IDs that contain it
    const catToSessionIds = {};
    const sessionOutcomes = {};

    sessions.forEach((s) => {
      const outcome = s[selectedOutcome];
      if (outcome == null) return;
      sessionOutcomes[s.id] = outcome;

      const seenCats = new Set();
      (s.event_timeline || []).forEach((ev) => {
        normalizeCategoryArray(ev.category).forEach((c) => {
          if (!seenCats.has(c)) {
            seenCats.add(c);
            if (!catToSessionIds[c]) catToSessionIds[c] = new Set();
            catToSessionIds[c].add(s.id);
          }
        });
      });
    });

    const outcomeSessionIds = Object.keys(sessionOutcomes);
    if (!outcomeSessionIds.length) return [];

    const globalAvg = outcomeSessionIds.reduce((sum, id) => sum + sessionOutcomes[id], 0) / outcomeSessionIds.length;

    return Object.entries(catToSessionIds)
      .map(([cat, idSet]) => {
        const withCat = [...idSet].filter((id) => sessionOutcomes[id] != null);
        if (withCat.length < 2) return null; // need enough data

        const withoutCat = outcomeSessionIds.filter((id) => !idSet.has(id));

        const avgWith = withCat.reduce((sum, id) => sum + sessionOutcomes[id], 0) / withCat.length;
        const avgWithout = withoutCat.length
          ? withoutCat.reduce((sum, id) => sum + sessionOutcomes[id], 0) / withoutCat.length
          : globalAvg;

        const delta = avgWith - avgWithout;
        const meta = getCategoryMeta(cat);

        return {
          cat,
          label: meta.label,
          color: meta.color,
          avgWith: +avgWith.toFixed(2),
          avgWithout: +avgWithout.toFixed(2),
          delta: +delta.toFixed(2),
          sessionCount: withCat.length,
        };
      })
      .filter(Boolean)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }, [sessions, selectedOutcome]);

  // Per-category avg outcome chart data
  const chartData = useMemo(
    () => correlationData.map((d) => ({
      name: d.label,
      "With Category": d.avgWith,
      "Without Category": d.avgWithout,
      color: d.color,
    })),
    [correlationData]
  );

  // Delta chart (positive = positive association, negative = negative)
  const deltaData = useMemo(
    () => correlationData.map((d) => ({
      name: d.label,
      delta: d.delta,
      color: d.delta >= 0 ? "hsl(var(--primary))" : "hsl(var(--destructive))",
      sessions: d.sessionCount,
    })),
    [correlationData]
  );

  // Category frequency (how many sessions each cat appears in)
  const freqData = useMemo(() => {
    const map = {};
    sessions.forEach((s) => {
      const seen = new Set();
      (s.event_timeline || []).forEach((ev) => {
        normalizeCategoryArray(ev.category).forEach((c) => {
          if (!seen.has(c)) { seen.add(c); map[c] = (map[c] || 0) + 1; }
        });
      });
    });
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => {
        const meta = getCategoryMeta(cat);
        return { name: meta.label, count, color: meta.color };
      });
  }, [sessions]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const sessionsWithEvents = sessions.filter((s) => (s.event_timeline || []).length > 0);

  if (!sessionsWithEvents.length) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2 text-center px-6">
        <BarChart2 className="w-10 h-10 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">No event timeline data found. Log events during sessions to unlock correlation insights.</p>
      </div>
    );
  }

  return (
    <div className="px-4 py-6 pb-24 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Event Correlations</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          How event categories relate to outcomes across {sessionsWithEvents.length} sessions
        </p>
      </div>

      {/* Outcome selector */}
      <div className="flex gap-2 flex-wrap">
        {Object.entries(OUTCOME_LABELS).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSelectedOutcome(key)}
            className="text-xs px-3 py-1.5 rounded-full border font-medium transition-all"
            style={selectedOutcome === key
              ? { background: OUTCOME_COLORS[key], color: "#fff", borderColor: OUTCOME_COLORS[key] }
              : { background: "transparent", color: "hsl(var(--muted-foreground))", borderColor: "hsl(var(--border))" }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Delta chart — impact on selected outcome */}
      {deltaData.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            Impact on {OUTCOME_LABELS[selectedOutcome]} (Δ vs. sessions without)
          </p>
          <p className="text-[10px] text-muted-foreground mb-3">Positive = higher {OUTCOME_LABELS[selectedOutcome].toLowerCase()} when category present</p>
          <div style={{ height: Math.max(120, deltaData.length * 36) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={deltaData} layout="vertical" margin={{ top: 0, right: 24, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 9 }} tickFormatter={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={90} />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0]?.payload;
                    return (
                      <div className="bg-card border border-border rounded-lg p-2 text-xs shadow-md">
                        <p className="font-semibold">{d.name}</p>
                        <p>Δ {OUTCOME_LABELS[selectedOutcome]}: <strong style={{ color: d.color }}>{d.delta > 0 ? "+" : ""}{d.delta.toFixed(2)}</strong></p>
                        <p className="text-muted-foreground">{d.sessions} sessions</p>
                      </div>
                    );
                  }}
                />
                <Bar dataKey="delta" radius={[0, 3, 3, 0]}>
                  {deltaData.map((d, i) => (
                    <Cell key={i} fill={d.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* With vs Without comparison */}
      {chartData.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Avg {OUTCOME_LABELS[selectedOutcome]}: With vs. Without Category
          </p>
          <div style={{ height: Math.max(120, chartData.length * 36) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                <XAxis type="number" domain={[0, 10]} tick={{ fontSize: 9 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={90} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="With Category" fill="hsl(var(--primary))" radius={[0, 3, 3, 0]} opacity={0.9} />
                <Bar dataKey="Without Category" fill="hsl(var(--border))" radius={[0, 3, 3, 0]} opacity={0.8} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Category frequency */}
      {freqData.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Category Frequency (sessions)
          </p>
          <div style={{ height: Math.max(80, freqData.length * 32) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={freqData} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 8 }}>
                <XAxis type="number" tick={{ fontSize: 9 }} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={90} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                  {freqData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* AI Correlation Analysis */}
      <EventCorrelationAI sessions={sessions} correlationData={correlationData} selectedOutcome={selectedOutcome} />
    </div>
  );
}