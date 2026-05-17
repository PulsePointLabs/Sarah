import { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import {
  LineChart, Line, BarChart, Bar, ScatterChart, Scatter,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import moment from "moment";
import { TrendingUp, Heart, Zap, Activity, BarChart2 } from "lucide-react";
import EventSummaryCard from "../components/EventSummaryCard";
import HRPerformanceMetrics from "../components/HRPerformanceMetrics";
import EventHRCorrelationView from "../components/EventHRCorrelationView";
import DashboardCustomizer from "../components/DashboardCustomizer";
import RecentSessionsWidget from "../components/dashboard/RecentSessionsWidget";
import CadenceWidget from "../components/dashboard/CadenceWidget";
import MoodContextWidget from "../components/dashboard/MoodContextWidget";
import TrendsSection from "../components/dashboard/TrendsSection";
import { useDashboardWidgets } from "@/hooks/useDashboardWidgets";

function StatCard({ label, value, sub, icon: Icon, color = "primary" }) {
  return (
    <div className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
      <div className={`p-2 rounded-lg bg-${color}/10`}>
        <Icon className={`w-5 h-5 text-${color}`} />
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-bold font-mono">{value ?? "—"}</p>
        {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}

function SectionTitle({ children }) {
  return <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{children}</h2>;
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg p-2 text-xs shadow-md">
      <p className="text-muted-foreground mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color }} className="font-mono font-semibold">
          {p.name}: {typeof p.value === "number" ? p.value.toFixed(1) : p.value}
        </p>
      ))}
    </div>
  );
};

export default function Dashboard() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const { config, toggleWidget, moveWidget, isVisible } = useDashboardWidgets();

  useEffect(() => {
    (async () => {
      const data = await base44.entities.Session.list("-date", 100);
      setSessions(data);
      setLoading(false);
    })();
  }, []);

  const stats = useMemo(() => {
    if (!sessions.length) return {};
    const avg = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null;
    const intensities = sessions.map((s) => s.intensity).filter(Boolean);
    const satisfactions = sessions.map((s) => s.satisfaction).filter(Boolean);
    const avgHRs = sessions.map((s) => s.avg_hr).filter(Boolean);
    const maxHRs = sessions.map((s) => s.max_hr).filter(Boolean);
    const favCount = sessions.filter((s) => s.is_favorite).length;
    return {
      total: sessions.length,
      avgIntensity: avg(intensities),
      avgSatisfaction: avg(satisfactions),
      avgHR: avg(avgHRs),
      peakHR: maxHRs.length ? Math.max(...maxHRs) : null,
      favCount,
    };
  }, [sessions]);

  const trendData = useMemo(() => {
    return [...sessions]
      .filter((s) => s.intensity || s.satisfaction || s.avg_hr)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(-20)
      .map((s) => ({
        date: moment(s.date).format("M/D"),
        Intensity: s.intensity || null,
        Satisfaction: s.satisfaction || null,
        "Avg HR": s.avg_hr || null,
      }));
  }, [sessions]);

  const monthlyData = useMemo(() => {
    const map = {};
    sessions.forEach((s) => {
      const key = moment(s.date).format("MMM YY");
      if (!map[key]) map[key] = { month: key, intensities: [], satisfactions: [], count: 0 };
      if (s.intensity) map[key].intensities.push(s.intensity);
      if (s.satisfaction) map[key].satisfactions.push(s.satisfaction);
      map[key].count++;
    });
    return Object.values(map)
      .sort((a, b) => moment(a.month, "MMM YY") - moment(b.month, "MMM YY"))
      .slice(-8)
      .map((m) => ({
        month: m.month,
        "Avg Intensity": m.intensities.length ? +(m.intensities.reduce((a, b) => a + b, 0) / m.intensities.length).toFixed(1) : null,
        "Avg Satisfaction": m.satisfactions.length ? +(m.satisfactions.reduce((a, b) => a + b, 0) / m.satisfactions.length).toFixed(1) : null,
        Sessions: m.count,
      }));
  }, [sessions]);

  const hrTrendData = useMemo(() => {
    return [...sessions]
      .filter((s) => s.avg_hr || s.max_hr || s.hr_at_climax)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(-20)
      .map((s) => ({
        date: moment(s.date).format("M/D"),
        "Avg HR": s.avg_hr || null,
        "Max HR": s.max_hr || null,
        "HR @ Climax": s.hr_at_climax || null,
      }));
  }, [sessions]);

  const methodFreq = useMemo(() => {
    const map = {};
    sessions.forEach((s) => (s.methods || []).forEach((m) => { map[m] = (map[m] || 0) + 1; }));
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([method, count]) => ({ method, count }));
  }, [sessions]);

  const scatterData = useMemo(() => {
    return sessions
      .filter((s) => s.intensity && s.satisfaction)
      .map((s) => ({ x: s.intensity, y: s.satisfaction }));
  }, [sessions]);

  const physioStats = useMemo(() => {
    const recoverySessions = sessions.filter(
      (s) => s.climax_offset_s != null && s.recovery_offset_s != null && s.hr_at_climax
    );
    let avgRecoveryRate = null;
    if (recoverySessions.length > 0) {
      const rates = recoverySessions
        .map((s) => {
          const dt = (s.recovery_offset_s - s.climax_offset_s) / 60;
          const drop = (s.hr_at_climax || s.max_hr || 0) - (s.avg_hr || 0);
          return dt > 0 ? drop / dt : null;
        })
        .filter((r) => r != null && r > 0);
      avgRecoveryRate = rates.length
        ? (rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(1)
        : null;
    }
    const climaxDurations = { short: 0, medium: 0, long: 0 };
    sessions.forEach((s) => { if (s.climax_duration) climaxDurations[s.climax_duration]++; });
    const totalWithDuration = climaxDurations.short + climaxDurations.medium + climaxDurations.long;
    const durationData = totalWithDuration > 0
      ? [
          { label: "Short", count: climaxDurations.short },
          { label: "Medium", count: climaxDurations.medium },
          { label: "Long", count: climaxDurations.long },
        ].filter((d) => d.count > 0)
      : [];
    const gaps = sessions
      .filter((s) => s.climax_offset_s != null && s.recovery_offset_s != null)
      .map((s) => s.recovery_offset_s - s.climax_offset_s)
      .filter((g) => g > 0);
    const avgGap = gaps.length
      ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)
      : null;
    return { avgRecoveryRate, durationData, totalWithDuration, avgGap, count: recoverySessions.length };
  }, [sessions]);

  // Build the ordered widget renderers (keyed by id)
  const WIDGETS = {
    cadence: isVisible("cadence") && <CadenceWidget key="cadence" sessions={sessions} />,
    recent: isVisible("recent") && <RecentSessionsWidget key="recent" sessions={sessions} />,
    mood: isVisible("mood") && <MoodContextWidget key="mood" sessions={sessions} />,
    stats: isVisible("stats") && (
      <div key="stats" className="grid grid-cols-2 gap-3">
        <StatCard label="Avg Intensity" value={stats.avgIntensity} icon={Zap} color="primary" sub="out of 10" />
        <StatCard label="Avg Satisfaction" value={stats.avgSatisfaction} icon={TrendingUp} color="accent" sub="out of 10" />
        <StatCard label="Avg Heart Rate" value={stats.avgHR ? `${stats.avgHR} bpm` : null} icon={Heart} color="chart-3" />
        <StatCard label="Peak HR" value={stats.peakHR ? `${stats.peakHR} bpm` : null} icon={Activity} color="destructive" />
      </div>
    ),

    trend: isVisible("trend") && trendData.length > 1 && (
      <div key="trend" className="bg-card rounded-xl border border-border p-4">
        <SectionTitle>Intensity & Satisfaction — Last {trendData.length} Sessions</SectionTitle>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trendData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={{ fontSize: 9 }} />
              <YAxis domain={[0, 10]} tick={{ fontSize: 9 }} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line type="monotone" dataKey="Intensity" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 2 }} connectNulls />
              <Line type="monotone" dataKey="Satisfaction" stroke="hsl(var(--accent))" strokeWidth={2} dot={{ r: 2 }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    ),

    hr_trend: isVisible("hr_trend") && hrTrendData.length > 1 && (
      <div key="hr_trend" className="bg-card rounded-xl border border-border p-4">
        <SectionTitle>Heart Rate Trends — Last {hrTrendData.length} Sessions</SectionTitle>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={hrTrendData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={{ fontSize: 9 }} />
              <YAxis domain={["auto", "auto"]} tick={{ fontSize: 9 }} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line type="monotone" dataKey="Avg HR" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={{ r: 2 }} connectNulls />
              <Line type="monotone" dataKey="Max HR" stroke="hsl(var(--destructive))" strokeWidth={2} dot={{ r: 2 }} connectNulls />
              <Line type="monotone" dataKey="HR @ Climax" stroke="hsl(var(--chart-3))" strokeWidth={2} dot={{ r: 2 }} connectNulls strokeDasharray="4 2" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    ),

    monthly: isVisible("monthly") && monthlyData.length > 1 && (
      <div key="monthly" className="bg-card rounded-xl border border-border p-4">
        <SectionTitle>Monthly Averages</SectionTitle>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthlyData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="month" tick={{ fontSize: 9 }} />
              <YAxis domain={[0, 10]} tick={{ fontSize: 9 }} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="Avg Intensity" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
              <Bar dataKey="Avg Satisfaction" fill="hsl(var(--accent))" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    ),

    methods: isVisible("methods") && methodFreq.length > 0 && (
      <div key="methods" className="bg-card rounded-xl border border-border p-4">
        <SectionTitle>Method Usage</SectionTitle>
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={methodFreq} layout="vertical" margin={{ top: 0, right: 4, bottom: 0, left: 4 }}>
              <XAxis type="number" tick={{ fontSize: 9 }} allowDecimals={false} />
              <YAxis type="category" dataKey="method" tick={{ fontSize: 9 }} width={80} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="count" fill="hsl(var(--chart-2))" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    ),

    physio: isVisible("physio") && (physioStats.avgRecoveryRate || physioStats.durationData.length > 0 || physioStats.avgGap) && (
      <div key="physio" className="bg-card rounded-xl border border-border p-4 space-y-4">
        <SectionTitle>Physiological Patterns</SectionTitle>
        <div className="grid grid-cols-2 gap-3">
          {physioStats.avgGap && (
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Avg Climax Duration</p>
              <p className="text-2xl font-bold font-mono text-chart-3">
                {physioStats.avgGap >= 60
                  ? `${Math.floor(physioStats.avgGap / 60)}m ${physioStats.avgGap % 60}s`
                  : `${physioStats.avgGap}s`}
              </p>
              <p className="text-[10px] text-muted-foreground">across {physioStats.count} sessions</p>
            </div>
          )}
          {physioStats.avgRecoveryRate && (
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Avg Recovery Rate</p>
              <p className="text-2xl font-bold font-mono text-chart-2">{physioStats.avgRecoveryRate} <span className="text-sm font-normal">bpm/min</span></p>
              <p className="text-[10px] text-muted-foreground">HR drop from climax</p>
            </div>
          )}
        </div>
        {physioStats.durationData.length > 0 && (
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Climax Duration Distribution</p>
            <div className="h-32">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={physioStats.durationData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 9 }} allowDecimals={false} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="count" fill="hsl(var(--chart-3))" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    ),

    trends: isVisible("trends") && <TrendsSection key="trends" sessions={sessions} />,

    hr_perf: isVisible("hr_perf") && <HRPerformanceMetrics key="hr_perf" sessions={sessions} />,

    events: isVisible("events") && <EventSummaryCard key="events" sessions={sessions} />,

    event_hr: isVisible("event_hr") && <EventHRCorrelationView key="event_hr" sessions={sessions} />,

    scatter: isVisible("scatter") && scatterData.length > 2 && (
      <div key="scatter" className="bg-card rounded-xl border border-border p-4">
        <SectionTitle>Intensity vs. Satisfaction</SectionTitle>
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="x" name="Intensity" domain={[1, 10]} tick={{ fontSize: 9 }} label={{ value: "Intensity", position: "insideBottom", fontSize: 9, offset: -2 }} />
              <YAxis dataKey="y" name="Satisfaction" domain={[1, 10]} tick={{ fontSize: 9 }} />
              <Tooltip cursor={{ strokeDasharray: "3 3" }} content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0]?.payload;
                return (
                  <div className="bg-card border border-border rounded-lg p-2 text-xs shadow-md">
                    <p>Intensity: <strong>{d.x}</strong></p>
                    <p>Satisfaction: <strong>{d.y}</strong></p>
                  </div>
                );
              }} />
              <Scatter data={scatterData} fill="hsl(var(--chart-4))" opacity={0.7} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>
    ),
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!sessions.length) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2 text-center px-6">
        <BarChart2 className="w-10 h-10 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">No sessions yet. Log your first session to see your dashboard.</p>
      </div>
    );
  }

  return (
    <div className="px-4 py-6 pb-24 space-y-6">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{stats.total} sessions recorded</p>
        </div>
        <DashboardCustomizer
          config={config}
          onToggle={toggleWidget}
          onReorder={moveWidget}
        />
      </div>

      {/* Render widgets in user-defined order */}
      {config.map((w) => {
        const el = WIDGETS[w.id];
        return el || null;
      })}
    </div>
  );
}