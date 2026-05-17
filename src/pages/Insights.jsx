import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import PageHeader from "../components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Trophy, Heart, TrendingUp, TrendingDown, AlertTriangle, Star, Layers, Brain, Activity } from "lucide-react";
import moment from "moment";
import { Link } from "react-router-dom";
import BestSessionPanel from "../components/BestSessionPanel";
import HRSatisfactionCorrelationChart from "../components/HRSatisfactionCorrelationChart";

function InsightCard({ icon: Icon, color, title, description, sessionId }) {
  const content = (
    <div className="bg-card rounded-xl border border-border p-4 flex gap-3 items-start">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 bg-muted`}>
        <Icon className="w-5 h-5 text-primary" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
    </div>
  );
  if (sessionId) return <Link to={`/sessions/${sessionId}`}>{content}</Link>;
  return content;
}

export default function Insights() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const data = await base44.entities.Session.list("-date", 500);
      setSessions(data);
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div>
        <PageHeader title="Insights" subtitle="Smart analysis of your sessions" />
        <div className="px-4 text-center py-12 text-muted-foreground text-sm">
          Record some sessions first to see insights
        </div>
      </div>
    );
  }

  const insights = [];

  // Highest intensity
  const maxIntensity = sessions.reduce((best, s) => (!best || s.intensity > best.intensity ? s : best), null);
  if (maxIntensity) {
    insights.push({
      icon: Trophy,
      title: `Peak Intensity: ${maxIntensity.intensity}/10`,
      description: `Achieved on ${moment(maxIntensity.date).format("MMM D, YYYY")} using ${(maxIntensity.methods || []).join(", ")}`,
      sessionId: maxIntensity.id,
    });
  }

  // Highest Build Quality
  const maxBQ = sessions.filter((s) => s.build_quality).reduce((best, s) => (!best || s.build_quality > best.build_quality ? s : best), null);
  if (maxBQ) {
    insights.push({
      icon: TrendingUp,
      title: `Peak Build Quality: ${maxBQ.build_quality}/10`,
      description: `On ${moment(maxBQ.date).format("MMM D, YYYY")}${maxBQ.build_type ? ` — ${maxBQ.build_type} build` : ""}`,
      sessionId: maxBQ.id,
    });
  }

  // Highest HR
  const maxHRSession = sessions.filter((s) => s.max_hr).reduce((best, s) => (!best || s.max_hr > best.max_hr ? s : best), null);
  if (maxHRSession) {
    insights.push({
      icon: Heart,
      title: `Peak HR: ${maxHRSession.max_hr} bpm`,
      description: `Recorded on ${moment(maxHRSession.date).format("MMM D, YYYY")}`,
      sessionId: maxHRSession.id,
    });
  }

  // Intensity trend
  if (sessions.length >= 6) {
    const recent5 = sessions.slice(0, 5);
    const prev5 = sessions.slice(5, 10);
    const recentAvg = recent5.reduce((a, s) => a + (s.intensity || 0), 0) / recent5.length;
    const prevAvg = prev5.reduce((a, s) => a + (s.intensity || 0), 0) / prev5.length;
    const diff = recentAvg - prevAvg;
    if (Math.abs(diff) >= 0.5) {
      insights.push({
        icon: diff > 0 ? TrendingUp : TrendingDown,
        title: `Intensity ${diff > 0 ? "Trending Up ↑" : "Trending Down ↓"}`,
        description: `Recent avg: ${recentAvg.toFixed(1)} vs previous: ${prevAvg.toFixed(1)} (${diff > 0 ? "+" : ""}${diff.toFixed(1)})`,
      });
    }
  }

  // Build Quality trend
  const bqSessions = sessions.filter((s) => s.build_quality);
  if (bqSessions.length >= 6) {
    const r5 = bqSessions.slice(0, 5);
    const p5 = bqSessions.slice(5, 10);
    const rAvg = r5.reduce((a, s) => a + s.build_quality, 0) / r5.length;
    const pAvg = p5.reduce((a, s) => a + s.build_quality, 0) / p5.length;
    const d = rAvg - pAvg;
    if (Math.abs(d) >= 0.5) {
      insights.push({
        icon: d > 0 ? TrendingUp : TrendingDown,
        title: `Build Quality ${d > 0 ? "Improving ↑" : "Declining ↓"}`,
        description: `Recent avg: ${rAvg.toFixed(1)} vs previous: ${pAvg.toFixed(1)} (${d > 0 ? "+" : ""}${d.toFixed(1)})`,
      });
    }
  }

  // BQ vs Intensity correlation
  const paired = sessions.filter((s) => s.build_quality && s.intensity);
  if (paired.length >= 3) {
    const highBQ = paired.filter((s) => s.build_quality >= 7);
    const lowBQ = paired.filter((s) => s.build_quality <= 4);
    if (highBQ.length >= 2 && lowBQ.length >= 2) {
      const highAvgInt = highBQ.reduce((a, s) => a + s.intensity, 0) / highBQ.length;
      const lowAvgInt = lowBQ.reduce((a, s) => a + s.intensity, 0) / lowBQ.length;
      if (highAvgInt - lowAvgInt > 0.5) {
        insights.push({
          icon: TrendingUp,
          title: "Higher Build Quality → Higher Intensity",
          description: `Sessions with BQ ≥7 avg intensity ${highAvgInt.toFixed(1)} vs BQ ≤4 avg ${lowAvgInt.toFixed(1)}`,
        });
      }
    }
  }

  // Best method combo for Build Quality (combinations counted together)
  const comboBQ = {};
  sessions.forEach((s) => {
    if (!s.build_quality || !(s.methods || []).length) return;
    const key = [...(s.methods || [])].sort().join(" + ");
    if (!comboBQ[key]) comboBQ[key] = { total: 0, count: 0 };
    comboBQ[key].total += s.build_quality;
    comboBQ[key].count++;
  });
  const comboBQAvgs = Object.entries(comboBQ)
    .filter(([_, v]) => v.count >= 2)
    .map(([name, v]) => ({ name, avg: v.total / v.count, count: v.count }))
    .sort((a, b) => b.avg - a.avg);
  if (comboBQAvgs.length > 0) {
    insights.push({
      icon: Star,
      title: `Best Combo for Build Quality: ${comboBQAvgs[0].name}`,
      description: `Avg BQ ${comboBQAvgs[0].avg.toFixed(1)}/10 across ${comboBQAvgs[0].count} sessions`,
    });
  }

  // Build Type vs Max HR
  const buildTypeHR = {};
  sessions.forEach((s) => {
    if (!s.build_type || !s.max_hr) return;
    const key = s.build_type === "Other" && s.custom_build_type ? s.custom_build_type : s.build_type;
    if (!buildTypeHR[key]) buildTypeHR[key] = { total: 0, count: 0 };
    buildTypeHR[key].total += s.max_hr;
    buildTypeHR[key].count++;
  });
  const buildTypeHRAvgs = Object.entries(buildTypeHR)
    .filter(([_, v]) => v.count >= 2)
    .sort((a, b) => (b[1].total / b[1].count) - (a[1].total / a[1].count));
  if (buildTypeHRAvgs.length > 0) {
    const [topType, topStats] = buildTypeHRAvgs[0];
    insights.push({
      icon: Layers,
      title: `"${topType}" builds → Highest Avg HR`,
      description: `Avg max HR of ${(topStats.total / topStats.count).toFixed(0)} bpm across ${topStats.count} sessions`,
    });
  }

  // Build Type vs Satisfaction
  const buildTypeSat = {};
  sessions.forEach((s) => {
    if (!s.build_type || !s.satisfaction) return;
    const key = s.build_type === "Other" && s.custom_build_type ? s.custom_build_type : s.build_type;
    if (!buildTypeSat[key]) buildTypeSat[key] = { total: 0, count: 0 };
    buildTypeSat[key].total += s.satisfaction;
    buildTypeSat[key].count++;
  });
  const satAvgs = Object.entries(buildTypeSat)
    .filter(([_, v]) => v.count >= 2)
    .sort((a, b) => (b[1].total / b[1].count) - (a[1].total / a[1].count));
  if (satAvgs.length > 0) {
    const [topType, stats] = satAvgs[0];
    insights.push({
      icon: Star,
      title: `Best Satisfaction: "${topType}" builds`,
      description: `Avg satisfaction ${(stats.total / stats.count).toFixed(1)}/10 across ${stats.count} sessions`,
    });
  }

  // Mood vs satisfaction correlation
  const moodSat = {};
  sessions.forEach((s) => {
    if (!s.mood || !s.satisfaction) return;
    if (!moodSat[s.mood]) moodSat[s.mood] = { total: 0, count: 0 };
    moodSat[s.mood].total += s.satisfaction;
    moodSat[s.mood].count++;
  });
  const moodSatAvgs = Object.entries(moodSat)
    .filter(([_, v]) => v.count >= 2)
    .map(([mood, v]) => ({ mood, avg: v.total / v.count, count: v.count }))
    .sort((a, b) => b.avg - a.avg);
  if (moodSatAvgs.length >= 2) {
    const best = moodSatAvgs[0];
    const worst = moodSatAvgs[moodSatAvgs.length - 1];
    insights.push({
      icon: Brain,
      title: `Best Mood for Satisfaction: "${best.mood.charAt(0).toUpperCase() + best.mood.slice(1)}"`,
      description: `Avg satisfaction ${best.avg.toFixed(1)}/10 vs "${worst.mood.charAt(0).toUpperCase() + worst.mood.slice(1)}" at ${worst.avg.toFixed(1)}/10`,
    });
  }

  // Discomfort warning
  const discomfortSessions = sessions.filter((s) => s.discomfort);
  if (discomfortSessions.length > 0) {
    const pct = ((discomfortSessions.length / sessions.length) * 100).toFixed(0);
    insights.push({
      icon: AlertTriangle,
      title: `${discomfortSessions.length} sessions with discomfort`,
      description: `${pct}% of all sessions reported discomfort`,
    });
  }

  // Climax duration insight (longer pre→climax gap = more powerful)
  const climaxSessions = sessions.filter((s) => s.pre_climax_offset_s != null && s.climax_offset_s != null);
  if (climaxSessions.length >= 2) {
    const durations = climaxSessions.map((s) => ({
      dur: Math.abs(s.climax_offset_s - s.pre_climax_offset_s),
      s,
    }));
    const avgDur = durations.reduce((a, d) => a + d.dur, 0) / durations.length;
    const longest = durations.reduce((best, d) => d.dur > best.dur ? d : best, durations[0]);
    const fmtS = (v) => { const m = Math.floor(v / 60); const s = Math.round(v % 60); return m > 0 ? `${m}m ${s}s` : `${s}s`; };
    insights.push({
      icon: TrendingUp,
      title: `Avg Climax Build Duration: ${fmtS(avgDur)}`,
      description: `Longest: ${fmtS(longest.dur)} on ${moment(longest.s.date).format("MMM D, YYYY")} — longer durations indicate stronger climax events`,
      sessionId: longest.s.id,
    });
  }

  // Pause time insight
  const calcPauseS = (s) => {
    const events = s.event_timeline || [];
    const cats = (ev) => Array.isArray(ev.category) ? ev.category : [ev.category].filter(Boolean);
    const sorted = [...events].sort((a, b) => a.time_s - b.time_s);
    let total = 0, start = null;
    for (const ev of sorted) {
      const c = cats(ev);
      if (c.includes("stimulation_paused") && start == null) start = ev.time_s;
      if (c.includes("stimulation_resumed") && start != null) { total += ev.time_s - start; start = null; }
    }
    return total;
  };
  const fmtS2 = (v) => { const m = Math.floor(v / 60); const sec = Math.round(v % 60); return m > 0 ? `${m}m ${sec}s` : `${sec}s`; };
  const pauseSessions = sessions.filter((s) => calcPauseS(s) > 0);
  if (pauseSessions.length >= 2) {
    const pauseTimes = pauseSessions.map((s) => calcPauseS(s));
    const avgPause = pauseTimes.reduce((a, b) => a + b, 0) / pauseTimes.length;
    // Correlation: low-pause vs high-pause sessions and satisfaction
    const median = [...pauseTimes].sort((a, b) => a - b)[Math.floor(pauseTimes.length / 2)];
    const lowPause = pauseSessions.filter((s) => calcPauseS(s) <= median && s.satisfaction);
    const highPause = pauseSessions.filter((s) => calcPauseS(s) > median && s.satisfaction);
    const lpAvg = lowPause.length ? lowPause.reduce((a, s) => a + s.satisfaction, 0) / lowPause.length : null;
    const hpAvg = highPause.length ? highPause.reduce((a, s) => a + s.satisfaction, 0) / highPause.length : null;
    const desc = lpAvg && hpAvg
      ? `Avg satisfaction: fewer pauses ${lpAvg.toFixed(1)}/10 vs more pauses ${hpAvg.toFixed(1)}/10`
      : `Avg pause time: ${fmtS2(avgPause)} across ${pauseSessions.length} sessions`;
    insights.push({
      icon: Activity,
      title: `Avg Pause Time: ${fmtS2(avgPause)}`,
      description: desc,
    });
  }

  // Climax → Recovery duration (recovery speed)
  const recSessions = sessions.filter((s) => s.climax_offset_s != null && s.recovery_offset_s != null);
  if (recSessions.length >= 2) {
    const recDurs = recSessions.map((s) => Math.abs(s.recovery_offset_s - s.climax_offset_s));
    const avgRec = recDurs.reduce((a, d) => a + d, 0) / recDurs.length;
    const fmtS = (v) => { const m = Math.floor(v / 60); const sec = Math.round(v % 60); return m > 0 ? `${m}m ${sec}s` : `${sec}s`; };
    insights.push({
      icon: Activity,
      title: `Avg Recovery Time After Climax: ${fmtS(avgRec)}`,
      description: `Based on ${recSessions.length} sessions with marked recovery points`,
    });
  }

  // Combo vs avg satisfaction
  const comboSat = {};
  sessions.forEach((s) => {
    if (!s.satisfaction || !(s.methods || []).length) return;
    const key = [...(s.methods || [])].sort().join(" + ");
    if (!comboSat[key]) comboSat[key] = { total: 0, count: 0 };
    comboSat[key].total += s.satisfaction;
    comboSat[key].count++;
  });
  const comboSatAvgs = Object.entries(comboSat)
    .filter(([_, v]) => v.count >= 2)
    .map(([name, v]) => ({ name, avg: v.total / v.count, count: v.count }))
    .sort((a, b) => b.avg - a.avg);
  if (comboSatAvgs.length > 0) {
    insights.push({
      icon: Activity,
      title: `Highest Satisfaction Combo: ${comboSatAvgs[0].name}`,
      description: `Avg satisfaction ${comboSatAvgs[0].avg.toFixed(1)}/10 across ${comboSatAvgs[0].count} sessions`,
    });
  }

  // Method combo BQ rankings
  const comboAvgs = Object.entries(comboBQ)
    .map(([name, v]) => ({ name, avg: v.total / v.count, count: v.count }))
    .sort((a, b) => b.avg - a.avg);
  const rankedMethods = comboAvgs;

  return (
    <div>
      <PageHeader title="Insights" subtitle={`Based on ${sessions.length} sessions`} />

      <div className="px-4 space-y-3 pb-6">
        <div className="flex flex-wrap gap-2 mb-2">
          <Badge variant="outline" className="py-1">{sessions.length} sessions</Badge>
          <Badge variant="outline" className="py-1">
            Since {moment(sessions[sessions.length - 1].date).format("MMM YYYY")}
          </Badge>
        </div>

        <BestSessionPanel sessions={sessions} />

        <HRSatisfactionCorrelationChart sessions={sessions} />

        {insights.map((insight, i) => <InsightCard key={i} {...insight} />)}

        {rankedMethods.length > 0 && (
          <div className="bg-card rounded-xl border border-border p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Build Quality Rankings by Method Combination
            </h3>
            <div className="space-y-2">
              {rankedMethods.map((m, i) => (
                <div key={m.name} className="flex items-center gap-3">
                  <span className="text-xs font-bold font-mono w-5 text-muted-foreground">{i + 1}</span>
                  <div className="flex-1">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="font-medium">{m.name}</span>
                      <span className="font-mono text-muted-foreground">{m.avg.toFixed(1)} ({m.count}x)</span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-primary rounded-full" style={{ width: `${(m.avg / 10) * 100}%` }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}