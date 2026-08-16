import { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import {
  LineChart, Line, BarChart, Bar, ScatterChart, Scatter,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import { Link } from "react-router-dom";
import moment from "moment";
import {
  TrendingUp, Heart, Zap, Activity, BarChart2, Sparkles, ClipboardList,
  ArrowUpRight, AlertCircle, CheckCircle2, CalendarClock, Target, Gauge,
} from "lucide-react";
import EventSummaryCard from "../components/EventSummaryCard";
import HRPerformanceMetrics from "../components/HRPerformanceMetrics";
import EventHRCorrelationView from "../components/EventHRCorrelationView";
import DashboardCustomizer from "../components/DashboardCustomizer";
import RecentSessionsWidget from "../components/dashboard/RecentSessionsWidget";
import CadenceWidget from "../components/dashboard/CadenceWidget";
import MoodContextWidget from "../components/dashboard/MoodContextWidget";
import TrendsSection from "../components/dashboard/TrendsSection";
import { useDashboardWidgets } from "@/hooks/useDashboardWidgets";
import MotionClimaxOverview from "../components/MotionClimaxOverview";

const DASHBOARD_SESSION_FIELDS = [
  "id", "created_date", "updated_date", "date", "start_time", "end_time",
  "duration_minutes", "satisfaction", "intensity", "avg_hr", "max_hr",
  "hr_at_climax", "hr_avg_at_climax_window", "hr_avg_pre_to_climax",
  "is_favorite", "mood", "no_climax", "build_type", "build_quality",
  "buildup_quality", "climax_duration", "pre_climax_offset_s",
  "climax_offset_s", "recovery_offset_s", "methods",
];
const DASHBOARD_DETAIL_FIELDS = [
  "id", "date", "climax_offset_s", "event_timeline", "motion_analysis_summary",
];

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

const briefToneStyles = {
  primary: "border-primary/25 bg-primary/10 text-primary",
  accent: "border-accent/25 bg-accent/10 text-accent",
  good: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
  warn: "border-amber-500/25 bg-amber-500/10 text-amber-300",
  muted: "border-border bg-muted/40 text-muted-foreground",
};

function compactDate(date) {
  return date ? moment(date).format("MMM D") : "Unknown date";
}

function sessionTitle(session) {
  if (!session) return "No session";
  const pieces = [compactDate(session.date)];
  if (session.duration_minutes) pieces.push(`${session.duration_minutes}m`);
  if (session.satisfaction) pieces.push(`${session.satisfaction}/10 satisfaction`);
  return pieces.join(" · ");
}

function averageMetric(rows, key) {
  const values = rows.map((row) => Number(row[key])).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function signedDelta(value, suffix = "") {
  if (value == null || Number.isNaN(value)) return "No comparison yet";
  if (Math.abs(value) < 0.05) return "steady vs previous 5";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}${suffix} vs previous 5`;
}

function bestLabelFromCounts(items, fallback = "Keep logging") {
  const top = Object.entries(items).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : fallback;
}

function SignalCard({ icon: Icon, label, value, detail, tone = "primary" }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border ${briefToneStyles[tone] || briefToneStyles.primary}`}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <p className="mt-3 text-2xl font-bold tracking-tight">{value ?? "—"}</p>
      {detail && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p>}
    </div>
  );
}

function ReviewRow({ icon: Icon = AlertCircle, title, detail, to, tone = "warn" }) {
  const body = (
    <>
      <span className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${briefToneStyles[tone] || briefToneStyles.warn}`}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-snug text-foreground">{title}</span>
        {detail && <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{detail}</span>}
      </span>
      {to && <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
    </>
  );

  if (to) {
    return (
      <Link to={to} className="flex items-start gap-3 rounded-lg border border-border/70 bg-muted/25 p-3 transition hover:border-primary/40 hover:bg-muted/40">
        {body}
      </Link>
    );
  }

  return <div className="flex items-start gap-3 rounded-lg border border-border/70 bg-muted/25 p-3">{body}</div>;
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
  const [loadError, setLoadError] = useState("");
  const { config, toggleWidget, moveWidget, isVisible } = useDashboardWidgets();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await base44.entities.Session.listFields(DASHBOARD_SESSION_FIELDS, "-date", 100, undefined, { timeoutMs: 10000 });
        if (cancelled) return;
        setSessions(data);
        setLoadError("");
        setLoading(false);

        // Event and motion timelines are optional dashboard enrichment. Load a
        // recent window only after the compact dashboard is already visible.
        base44.entities.Session.listFields(DASHBOARD_DETAIL_FIELDS, "-date", 20, undefined, { timeoutMs: 15000 })
          .then((details) => {
            if (cancelled) return;
            const byId = new Map(details.map((session) => [session.id, session]));
            setSessions((current) => current.map((session) => ({ ...session, ...(byId.get(session.id) || {}) })));
          })
          .catch(() => {});
      } catch (error) {
        if (cancelled) return;
        setLoadError(error?.message || "Could not load dashboard data.");
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
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

  const dashboardBrief = useMemo(() => {
    if (!sessions.length) return {};

    const sorted = [...sessions].sort((a, b) => new Date(b.date) - new Date(a.date));
    const latest = sorted[0];
    const recent = sorted.slice(0, 5);
    const previous = sorted.slice(5, 10);
    const recentSatisfaction = averageMetric(recent, "satisfaction");
    const previousSatisfaction = averageMetric(previous, "satisfaction");
    const recentIntensity = averageMetric(recent, "intensity");
    const previousIntensity = averageMetric(previous, "intensity");
    const satisfactionDelta = recentSatisfaction != null && previousSatisfaction != null
      ? recentSatisfaction - previousSatisfaction
      : null;
    const intensityDelta = recentIntensity != null && previousIntensity != null
      ? recentIntensity - previousIntensity
      : null;

    const topSessions = sorted
      .filter((session) => session.satisfaction || session.intensity)
      .sort((a, b) => {
        const satDiff = (b.satisfaction || 0) - (a.satisfaction || 0);
        return satDiff || ((b.intensity || 0) - (a.intensity || 0));
      })
      .slice(0, 8);

    const methodCounts = {};
    const moodCounts = {};
    const buildCounts = {};
    topSessions.forEach((session) => {
      (session.methods || []).forEach((method) => {
        methodCounts[method] = (methodCounts[method] || 0) + 1;
      });
      if (session.mood) moodCounts[session.mood] = (moodCounts[session.mood] || 0) + 1;
      if (session.build_type) buildCounts[session.build_type] = (buildCounts[session.build_type] || 0) + 1;
    });

    const bestMethod = bestLabelFromCounts(methodCounts);
    const bestMood = bestLabelFromCounts(moodCounts, null);
    const bestBuild = bestLabelFromCounts(buildCounts, null);
    const peakHR = Math.max(
      ...sessions
        .map((session) => Number(session.max_hr || session.hr_at_climax || 0))
        .filter((value) => value > 0)
    );
    const recentPeak = recent.find((session) => Number(session.max_hr || session.hr_at_climax || 0) === peakHR);

    const missingAi = sorted.filter((session) => !session.ai_analysis?.summary && !session.ai_summary).slice(0, 3);
    const missingMarkers = sorted
      .filter((session) => !session.no_climax && session.climax_offset_s == null && session.recovery_offset_s == null)
      .slice(0, 3);
    const highEffortLowReward = sorted
      .filter((session) => Number(session.intensity) >= 8 && Number(session.satisfaction) <= 6)
      .slice(0, 2);
    const noHrData = sorted
      .filter((session) => !session.avg_hr && !session.max_hr && !session.hr_at_climax)
      .slice(0, 2);

    const reviewItems = [];
    if (missingAi.length) {
      reviewItems.push({
        icon: Sparkles,
        title: `${missingAi.length} session${missingAi.length > 1 ? "s" : ""} ready for AI analysis`,
        detail: `Start with ${sessionTitle(missingAi[0])}.`,
        to: `/sessions/${missingAi[0].id}`,
        tone: "primary",
      });
    }
    if (missingMarkers.length) {
      reviewItems.push({
        icon: Target,
        title: `${missingMarkers.length} session${missingMarkers.length > 1 ? "s" : ""} missing climax or recovery markers`,
        detail: `First one is ${sessionTitle(missingMarkers[0])}.`,
        to: `/sessions/${missingMarkers[0].id}`,
        tone: "warn",
      });
    }
    if (highEffortLowReward.length) {
      reviewItems.push({
        icon: AlertCircle,
        title: "High intensity with lower satisfaction",
        detail: `${sessionTitle(highEffortLowReward[0])} may be worth reviewing for friction points.`,
        to: `/sessions/${highEffortLowReward[0].id}`,
        tone: "warn",
      });
    }
    if (noHrData.length) {
      reviewItems.push({
        icon: Heart,
        title: `${noHrData.length} session${noHrData.length > 1 ? "s" : ""} without heart-rate data`,
        detail: `Add physiology when available, starting with ${compactDate(noHrData[0].date)}.`,
        to: `/sessions/${noHrData[0].id}`,
        tone: "muted",
      });
    }

    const bestRecent = recent
      .filter((session) => session.satisfaction || session.intensity)
      .sort((a, b) => ((b.satisfaction || 0) - (a.satisfaction || 0)) || ((b.intensity || 0) - (a.intensity || 0)))[0];

    const briefLine = latest
      ? `Latest: ${sessionTitle(latest)}. Your recent average is ${recentSatisfaction ? `${recentSatisfaction.toFixed(1)}/10 satisfaction` : "still forming"}${recentIntensity ? ` with ${recentIntensity.toFixed(1)}/10 intensity` : ""}.`
      : "Start logging sessions to build a useful pulse brief.";

    return {
      latest,
      recentSatisfaction,
      recentIntensity,
      satisfactionDelta,
      intensityDelta,
      bestMethod,
      bestMood,
      bestBuild,
      bestRecent,
      peakHR: Number.isFinite(peakHR) ? peakHR : null,
      recentPeak,
      reviewItems: reviewItems.slice(0, 4),
      briefLine,
    };
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
        {loadError ? <AlertCircle className="w-10 h-10 text-destructive" /> : <BarChart2 className="w-10 h-10 text-muted-foreground" />}
        <p className={loadError ? "text-destructive text-sm" : "text-muted-foreground text-sm"}>
          {loadError || "No sessions yet. Log your first session to see your dashboard."}
        </p>
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

      <div className="grid gap-4 lg:grid-cols-[1.35fr_0.9fr]">
        <section className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
              <Sparkles className="h-4.5 w-4.5" />
            </span>
            <div>
              <SectionTitle>Pulse Brief</SectionTitle>
              <p className="text-xs text-muted-foreground">A quick read on where things stand right now</p>
            </div>
          </div>
          <p className="mt-5 max-w-3xl text-lg font-semibold leading-snug">
            {dashboardBrief.briefLine}
          </p>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border/70 bg-muted/25 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Latest Session</p>
              {dashboardBrief.latest ? (
                <Link to={`/sessions/${dashboardBrief.latest.id}`} className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-foreground hover:text-primary">
                  {compactDate(dashboardBrief.latest.date)}
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">No latest session</p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                {dashboardBrief.latest?.duration_minutes ? `${dashboardBrief.latest.duration_minutes} minutes` : "Duration not logged"}
              </p>
            </div>
            <div className="rounded-lg border border-border/70 bg-muted/25 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Best Recent</p>
              {dashboardBrief.bestRecent ? (
                <Link to={`/sessions/${dashboardBrief.bestRecent.id}`} className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-foreground hover:text-primary">
                  {compactDate(dashboardBrief.bestRecent.date)}
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">Still forming</p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                {dashboardBrief.bestRecent?.satisfaction ? `${dashboardBrief.bestRecent.satisfaction}/10 satisfaction` : "No rating yet"}
              </p>
            </div>
            <div className="rounded-lg border border-border/70 bg-muted/25 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Reliable Ingredient</p>
              <p className="mt-1 truncate text-sm font-medium text-foreground">{dashboardBrief.bestMethod}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {dashboardBrief.bestMood || dashboardBrief.bestBuild
                  ? [dashboardBrief.bestMood, dashboardBrief.bestBuild].filter(Boolean).join(" · ")
                  : "Based on top-rated sessions"}
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-accent/25 bg-accent/10 text-accent">
                <ClipboardList className="h-4.5 w-4.5" />
              </span>
              <div>
                <SectionTitle>Review Queue</SectionTitle>
                <p className="text-xs text-muted-foreground">Small things that would make the data sharper</p>
              </div>
            </div>
            <span className="rounded-full bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">
              {dashboardBrief.reviewItems?.length || 0}
            </span>
          </div>
          <div className="mt-4 space-y-2">
            {dashboardBrief.reviewItems?.length ? (
              dashboardBrief.reviewItems.map((item) => (
                <ReviewRow key={`${item.title}-${item.to}`} {...item} />
              ))
            ) : (
              <ReviewRow
                icon={CheckCircle2}
                title="Nothing urgent to clean up"
                detail="Your recent sessions have enough detail to keep the dashboard useful."
                tone="good"
              />
            )}
          </div>
        </section>
      </div>

      <div>
        <SectionTitle>Signals</SectionTitle>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SignalCard
            icon={TrendingUp}
            label="Satisfaction"
            value={dashboardBrief.recentSatisfaction != null ? `${dashboardBrief.recentSatisfaction.toFixed(1)}/10` : null}
            detail={signedDelta(dashboardBrief.satisfactionDelta)}
            tone={dashboardBrief.satisfactionDelta == null ? "muted" : dashboardBrief.satisfactionDelta >= 0 ? "good" : "warn"}
          />
          <SignalCard
            icon={Zap}
            label="Intensity"
            value={dashboardBrief.recentIntensity != null ? `${dashboardBrief.recentIntensity.toFixed(1)}/10` : null}
            detail={signedDelta(dashboardBrief.intensityDelta)}
            tone="primary"
          />
          <SignalCard
            icon={Gauge}
            label="Peak HR"
            value={dashboardBrief.peakHR ? `${dashboardBrief.peakHR} bpm` : null}
            detail={dashboardBrief.recentPeak ? `Matched recently on ${compactDate(dashboardBrief.recentPeak.date)}` : "All-time observed peak"}
            tone="accent"
          />
          <SignalCard
            icon={CalendarClock}
            label="Recovery Window"
            value={physioStats.avgGap ? (physioStats.avgGap >= 60 ? `${Math.floor(physioStats.avgGap / 60)}m ${physioStats.avgGap % 60}s` : `${physioStats.avgGap}s`) : null}
            detail={physioStats.count ? `Averaged across ${physioStats.count} marked sessions` : "Add climax and recovery markers"}
            tone="muted"
          />
        </div>
      </div>

      <MotionClimaxOverview sessions={sessions} />

      {/* Render widgets in user-defined order */}
      {config.map((w) => {
        const el = WIDGETS[w.id];
        return el || null;
      })}
    </div>
  );
}
