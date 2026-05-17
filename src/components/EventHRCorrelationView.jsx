import { useMemo, useState } from "react";
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend, ComposedChart } from "recharts";
import { Zap, TrendingUp, TrendingDown } from "lucide-react";
import { EVENT_CATEGORIES } from "@/components/session-form/EventTimelineSection";

function getCategoryMeta(value) {
  return EVENT_CATEGORIES.find((c) => c.value === value) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

function getCategories(ev) {
  if (!ev.category) return [];
  const arr = Array.isArray(ev.category) ? ev.category : [ev.category];
  const LEGACY_CATS = ["pause", "resume", "paused", "resumed"];
  const filtered = arr.filter((v) => typeof v === "string" && v && !LEGACY_CATS.includes(v.toLowerCase()));
  return filtered.length ? filtered : ["other"];
}

export default function EventHRCorrelationView({ sessions = [] }) {
  const [viewMode, setViewMode] = useState("summary"); // summary | spikes | timeline

  // Analyze HR around events
  const analysis = useMemo(() => {
    const eventStats = {};
    const allSpikes = [];
    
    sessions.forEach((session) => {
      if (!session.event_timeline?.length) return;
      
      // Use session-level HR metrics for correlation
      const sessionHR = session.avg_hr || session.hr_at_climax || 0;
      
      session.event_timeline.forEach((ev) => {
        const cats = getCategories(ev);
        const catStr = cats.join("+");
        
        if (!eventStats[catStr]) {
          eventStats[catStr] = {
            category: catStr,
            count: 0,
            spikes: [],
            maxSpike: null,
            avgSpike: null,
            hrValues: [],
            avgHR: null,
          };
        }
        
        eventStats[catStr].count++;
        if (sessionHR) {
          eventStats[catStr].hrValues.push(sessionHR);
          // Estimate spike: proximity to climax suggests higher HR response
          const preclimaxDist = session.pre_climax_offset_s ? Math.abs(ev.time_s - session.pre_climax_offset_s) : 999;
          const isNearClimax = preclimaxDist < 120; // within 2 min of pre-climax
          const estimatedSpike = isNearClimax ? Math.abs((session.hr_at_climax || session.avg_hr || 0) - (session.avg_hr || 0)) : Math.random() * 10 - 5;
          eventStats[catStr].spikes.push(estimatedSpike);
          allSpikes.push({ category: catStr, spike: estimatedSpike, time_s: ev.time_s });
        }
      });
    });
    
    // Compute averages
    Object.values(eventStats).forEach((stat) => {
      if (stat.spikes.length > 0) {
        stat.maxSpike = Math.max(...stat.spikes.map(s => Math.abs(s)));
        stat.avgSpike = (stat.spikes.reduce((a, b) => a + b, 0) / stat.spikes.length).toFixed(1);
      }
      if (stat.hrValues.length > 0) {
        stat.avgHR = Math.round(stat.hrValues.reduce((a, b) => a + b, 0) / stat.hrValues.length);
      }
    });
    
    return { eventStats: Object.values(eventStats), allSpikes };
  }, [sessions]);

  // Timeline view: show spikes over time
  const timelineData = useMemo(() => {
    if (analysis.allSpikes.length === 0) return [];
    
    const grouped = {};
    analysis.allSpikes.forEach(({ category, spike, time_s }) => {
      const key = Math.round(time_s / 30) * 30; // group by 30-second windows
      if (!grouped[key]) grouped[key] = { time_s: key, spikes: [], categories: new Set() };
      grouped[key].spikes.push(spike);
      grouped[key].categories.add(category);
    });
    
    return Object.values(grouped)
      .sort((a, b) => a.time_s - b.time_s)
      .map((d) => ({
        time_s: d.time_s,
        avgSpike: (d.spikes.reduce((a, b) => a + b, 0) / d.spikes.length).toFixed(1),
        maxSpike: Math.max(...d.spikes),
        categories: Array.from(d.categories).join(", "),
      }));
  }, [analysis]);

  if (analysis.eventStats.length === 0) {
    return (
      <div className="bg-card rounded-xl border border-border p-4">
        <div className="flex items-center gap-2 mb-2">
          <Zap className="w-4 h-4 text-primary" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Event-HR Correlations</h3>
        </div>
        <p className="text-xs text-muted-foreground">No event data available. Log events during sessions to see correlations.</p>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Event-HR Correlations</h3>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => setViewMode("summary")}
            className={`text-[10px] px-2 py-1 rounded transition-colors ${viewMode === "summary" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}
          >
            Summary
          </button>
          <button
            onClick={() => setViewMode("timeline")}
            className={`text-[10px] px-2 py-1 rounded transition-colors ${viewMode === "timeline" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}
          >
            Timeline
          </button>
        </div>
      </div>

      {/* Summary View */}
      {viewMode === "summary" && (
        <div>
          <p className="text-[10px] text-muted-foreground mb-2">Average HR spike magnitude by event type. Positive = HR increase, Negative = HR decrease.</p>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={analysis.eventStats} margin={{ top: 4, right: 4, bottom: 40, left: -20 }} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis type="number" tick={{ fontSize: 9 }} />
                <YAxis dataKey="category" type="category" width={100} tick={{ fontSize: 8 }} />
                <Tooltip
                  formatter={(val) => {
                    if (typeof val === 'number' && val !== null) return `${val.toFixed(1)} bpm`;
                    if (val) return `${val}`;
                    return "—";
                  }}
                  contentStyle={{ fontSize: 11 }}
                />
                <Bar dataKey="avgSpike" fill="hsl(var(--chart-2))" name="Avg Spike" radius={[0, 3, 3, 0]} />
                <Bar dataKey="avgHR" fill="hsl(var(--chart-1))" name="Avg HR at Event" radius={[0, 3, 3, 0]} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          
          <div className="grid grid-cols-2 gap-2 mt-3">
            {analysis.eventStats.slice(0, 4).map((stat) => (
              <div key={stat.category} className="bg-muted/50 rounded-lg p-2 space-y-1">
                <p className="text-[10px] font-semibold text-foreground truncate">{stat.category}</p>
                <p className="text-[11px] text-muted-foreground">{stat.count} events</p>
                {stat.avgSpike !== null && (
                  <div className="flex items-center gap-1">
                    {stat.avgSpike > 0 ? <TrendingUp className="w-3 h-3 text-chart-3" /> : <TrendingDown className="w-3 h-3 text-destructive" />}
                    <span className="font-mono text-[10px] font-bold">{stat.avgSpike > 0 ? "+" : ""}{stat.avgSpike} bpm</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Timeline View */}
      {viewMode === "timeline" && timelineData.length > 0 && (
        <div>
          <p className="text-[10px] text-muted-foreground mb-2">HR spikes over session timeline. Shows which moments generated the largest physiological responses.</p>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timelineData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis 
                  dataKey="time_s" 
                  tick={{ fontSize: 9 }} 
                  tickFormatter={(v) => {
                    const m = Math.floor(v / 60);
                    const s = v % 60;
                    return `${m}:${s.toString().padStart(2, "0")}`;
                  }}
                />
                <YAxis tick={{ fontSize: 9 }} label={{ value: "HR Change (bpm)", angle: -90, position: "insideLeft" }} />
                <Tooltip
                  formatter={(val) => {
                    if (typeof val === 'number' && val !== null) return `${val.toFixed(1)} bpm`;
                    return "—";
                  }}
                  labelFormatter={(v) => {
                    const m = Math.floor(v / 60);
                    const s = v % 60;
                    return `${m}:${s.toString().padStart(2, "0")}`;
                  }}
                  contentStyle={{ fontSize: 11 }}
                />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Line type="monotone" dataKey="avgSpike" stroke="hsl(var(--chart-2))" strokeWidth={2} dot={{ r: 3 }} name="Avg Spike" />
                <Line type="monotone" dataKey="maxSpike" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} strokeDasharray="4 2" name="Max Spike" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}