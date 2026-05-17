import { useMemo, useState, useEffect } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

// ── Scoring helpers ────────────────────────────────────────────────────────────

// HR Variability: std-dev of HR values (higher = more dynamic arousal arc = better, up to a point)
function calcHRVariability(rows) {
  if (!rows || rows.length < 5) return null;
  const hrs = rows.map((r) => Number(r.hr)).filter((v) => !isNaN(v));
  const mean = hrs.reduce((a, b) => a + b, 0) / hrs.length;
  const std = Math.sqrt(hrs.reduce((a, v) => a + (v - mean) ** 2, 0) / hrs.length);
  return std;
}

// Recovery time: seconds from climax to recovery marker (shorter = more efficient)
function calcRecoveryTime(session) {
  if (session?.climax_offset_s == null || session?.recovery_offset_s == null) return null;
  return Math.abs(session.recovery_offset_s - session.climax_offset_s);
}

// HR rise to climax: avg HR in pre→climax window (higher relative rise = stronger response)
function calcHRRise(session) {
  if (!session?.hr_avg_pre_to_climax || !session?.avg_hr) return null;
  return session.hr_avg_pre_to_climax - session.avg_hr;
}

// Pause time: total seconds between stimulation_paused and stimulation_resumed events
function calcPauseTime(session) {
  const events = session?.event_timeline || [];
  // normalize category to array
  const cats = (ev) => Array.isArray(ev.category) ? ev.category : [ev.category].filter(Boolean);
  const sorted = [...events].sort((a, b) => a.time_s - b.time_s);
  let totalPause = 0;
  let pauseStart = null;
  for (const ev of sorted) {
    const c = cats(ev);
    if (c.includes("stimulation_paused") && pauseStart == null) pauseStart = ev.time_s;
    if (c.includes("stimulation_resumed") && pauseStart != null) {
      totalPause += ev.time_s - pauseStart;
      pauseStart = null;
    }
  }
  return totalPause; // seconds
}

// Discomfort penalty: derived from discomfort_entries severity average, or boolean
function calcDiscomfortPenalty(session) {
  if (session?.discomfort_entries?.length > 0) {
    const avg = session.discomfort_entries.reduce((a, e) => a + (e.severity || 5), 0) / session.discomfort_entries.length;
    return avg; // 1–10
  }
  if (session?.discomfort) return 5; // generic penalty
  return 0;
}

// Climax duration score: long > medium > short
const CLIMAX_DUR_SCORE = { long: 10, medium: 7, short: 4 };

// Arousal build quality score (1–10, direct)
// Satisfaction score (1–10, direct)

function computeScore(session, timelineRows) {
  const factors = [];

  // 1. Satisfaction (0–25 pts)
  if (session.satisfaction) {
    factors.push({ label: "Satisfaction", score: (session.satisfaction / 10) * 25, max: 25 });
  }

  // 2. Build Quality (0–20 pts)
  if (session.build_quality) {
    factors.push({ label: "Build Quality", score: (session.build_quality / 10) * 20, max: 20 });
  }

  // 3. HR Variability (0–15 pts) — sweet spot 10–25 std BPM
  const hrVar = calcHRVariability(timelineRows);
  if (hrVar != null) {
    // Score peaks at ~18 std BPM, falls off at extremes
    const normalized = Math.min(1, hrVar < 18 ? hrVar / 18 : Math.max(0, 1 - (hrVar - 18) / 20));
    factors.push({ label: "HR Variability", score: normalized * 15, max: 15 });
  }

  // 4. Recovery Time (0–15 pts) — faster recovery = better efficiency
  const recoveryS = calcRecoveryTime(session);
  if (recoveryS != null) {
    // Under 90s = full score, 90–300s = partial, over 300s = 0
    const normalized = recoveryS <= 90 ? 1 : recoveryS >= 300 ? 0 : 1 - (recoveryS - 90) / 210;
    factors.push({ label: "Recovery Speed", score: normalized * 15, max: 15 });
  }

  // 5. Climax Duration (0–10 pts)
  if (session.climax_duration) {
    factors.push({ label: "Climax Duration", score: ((CLIMAX_DUR_SCORE[session.climax_duration] || 5) / 10) * 10, max: 10 });
  }

  // 6. HR Rise to Climax (0–10 pts) — ≥20 bpm rise = full score
  const hrRise = calcHRRise(session);
  if (hrRise != null) {
    const normalized = Math.min(1, Math.max(0, hrRise / 20));
    factors.push({ label: "HR Arousal Rise", score: normalized * 10, max: 10 });
  }

  // 7. Pause time penalty (up to −10 pts) — more pauses = lower score
  const pauseS = calcPauseTime(session);
  if (pauseS > 0 && session.duration_minutes) {
    const sessionS = session.duration_minutes * 60;
    const pauseRatio = Math.min(1, pauseS / sessionS);
    factors.push({ label: "Pause Time", score: -pauseRatio * 10, max: 0, penalty: true });
  }

  // 8. Discomfort penalty (up to −15 pts)
  const discomfort = calcDiscomfortPenalty(session);
  if (discomfort > 0) {
    factors.push({ label: "Discomfort", score: -(discomfort / 10) * 15, max: 0, penalty: true });
  }

  if (!factors.length) return null;

  const totalMax = factors.filter((f) => !f.penalty).reduce((a, f) => a + f.max, 0);
  const totalScore = factors.reduce((a, f) => a + f.score, 0);
  const pct = totalMax > 0 ? Math.max(0, Math.min(100, (totalScore / totalMax) * 100)) : null;

  return { pct: Math.round(pct), factors, totalMax };
}

function gradeInfo(pct) {
  if (pct >= 85) return { grade: "A", label: "Excellent", color: "hsl(var(--chart-1))" };
  if (pct >= 70) return { grade: "B", label: "Good", color: "hsl(var(--primary))" };
  if (pct >= 55) return { grade: "C", label: "Average", color: "hsl(var(--chart-4))" };
  if (pct >= 40) return { grade: "D", label: "Below Avg", color: "hsl(var(--chart-3))" };
  return { grade: "F", label: "Low", color: "hsl(var(--destructive))" };
}

function fmtSec(s) {
  if (s == null) return null;
  const v = Math.round(s);
  return v >= 60 ? `${Math.floor(v / 60)}m ${v % 60}s` : `${v}s`;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function SessionExecutiveSummary({ session, timelineRows, onScoreComputed }) {
  const [collapsed, setCollapsed] = useState(true);
  
  // Always compute for factors; prefer persisted score for display
  const result = useMemo(() => computeScore(session, timelineRows), [session, timelineRows]);
  const scorePct = session.ai_analysis?.ai_score ?? result?.pct;
  
  // Notify parent if using computed score
  useEffect(() => {
    if (result && !session.ai_analysis?.ai_score && onScoreComputed) {
      onScoreComputed(result.pct);
    }
  }, [result?.pct, session.ai_analysis?.ai_score, onScoreComputed]);
  
  if (!scorePct) return null;

  const factors = result?.factors || [];
  const { grade, label, color } = gradeInfo(scorePct);

  const recoveryS = calcRecoveryTime(session);
  const hrVar = calcHRVariability(timelineRows);
  const hrRise = calcHRRise(session);
  const discomfortPenalty = calcDiscomfortPenalty(session);
  const pauseS = calcPauseTime(session);

  const highlights = [
    hrVar != null && {
      label: "HR Variability",
      value: `±${Math.round(hrVar)} bpm`,
      good: hrVar >= 8 && hrVar <= 30,
    },
    recoveryS != null && {
      label: "Recovery",
      value: fmtSec(recoveryS),
      good: recoveryS < 150,
    },
    hrRise != null && {
      label: "Arousal Rise",
      value: `+${Math.round(hrRise)} bpm`,
      good: hrRise >= 15,
    },
    session.climax_duration && {
      label: "Climax",
      value: session.climax_duration.charAt(0).toUpperCase() + session.climax_duration.slice(1),
      good: session.climax_duration !== "short",
    },
    pauseS > 0 && {
      label: "Paused",
      value: fmtSec(pauseS),
      good: false,
    },
    discomfortPenalty > 0 && {
      label: "Discomfort",
      value: session.discomfort_entries?.length > 0
        ? `Avg sev ${Math.round(session.discomfort_entries.reduce((a, e) => a + e.severity, 0) / session.discomfort_entries.length)}/10`
        : "Present",
      good: false,
    },
  ].filter(Boolean);

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-4">
      {/* Header */}
      <button className="w-full flex items-center justify-between" onClick={() => setCollapsed((v) => !v)}>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
          Executive Summary
        </h3>
        {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
      </button>

      {!collapsed && <>
      {/* Score ring + grade */}
      <div className="flex items-center gap-5">
        {/* Circular score */}
        <div className="relative shrink-0">
          <svg width="72" height="72" viewBox="0 0 72 72">
            <circle cx="36" cy="36" r="30" fill="none" stroke="hsl(var(--muted))" strokeWidth="6" />
            <circle
              cx="36" cy="36" r="30"
              fill="none"
              stroke={color}
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 30}`}
              strokeDashoffset={`${2 * Math.PI * 30 * (1 - scorePct / 100)}`}
              transform="rotate(-90 36 36)"
              style={{ transition: "stroke-dashoffset 0.6s ease" }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-xl font-bold font-mono leading-none" style={{ color }}>{grade}</span>
            <span className="text-[9px] text-muted-foreground font-mono">{scorePct}%</span>
          </div>
        </div>

        {/* Label + highlights */}
        <div className="flex-1 space-y-2">
          <p className="text-base font-bold leading-tight" style={{ color }}>{label} Session</p>

          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {highlights.map((h, i) => (
              <div key={i} className="flex items-center gap-1">
                {h.good
                  ? <TrendingUp className="w-3 h-3 shrink-0" style={{ color: "hsl(var(--chart-1))" }} />
                  : h.good === false
                    ? <TrendingDown className="w-3 h-3 shrink-0 text-destructive" />
                    : <Minus className="w-3 h-3 shrink-0 text-muted-foreground" />}
                <span className="text-[10px] text-muted-foreground">{h.label}</span>
                <span className="text-[10px] font-mono font-semibold text-foreground">{h.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Factor breakdown bars */}
      <div className="space-y-1.5 pt-1 border-t border-border">
        <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Score Breakdown</p>
        {factors.map((f, i) => {
          const barPct = f.penalty
            ? Math.abs(f.score / 15) * 100
            : f.max > 0 ? (f.score / f.max) * 100 : 0;
          return (
            <div key={i} className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-28 shrink-0">{f.label}</span>
              <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, barPct)}%`,
                    background: f.penalty ? "hsl(var(--destructive))" : color,
                    opacity: f.penalty ? 0.7 : 1,
                  }}
                />
              </div>
              <span className="text-[10px] font-mono font-bold w-8 text-right" style={{ color: f.penalty ? "hsl(var(--destructive))" : "hsl(var(--foreground))" }}>
                {f.penalty ? `−${Math.abs(Math.round(f.score))}` : `${Math.round(f.score)}/${f.max}`}
              </span>
            </div>
          );
        })}
      </div>
      </>}
    </div>
  );
}